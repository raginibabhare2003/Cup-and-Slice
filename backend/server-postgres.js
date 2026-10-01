'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

try {
    process.loadEnvFile(path.join(ROOT, '.env'));
} catch {}

const { query, close } = require('./db');

let webpush = null;

try {
    webpush = require('web-push');
} catch {}

const PORT = Number(process.env.PORT || 3000);

const DATA = path.join(ROOT, 'data');

const PUBLIC = path.join(ROOT, 'frontend');

fs.mkdirSync(DATA, { recursive: true });


function pgSql(sql) {

    let i = 0;

    return String(sql).replace(
        /\?/g,
        () => '$' + (++i)
    );
}


const db = {

    prepare(sql) {

        return {

            async get(...params) {

                const r = await query(
                    pgSql(sql),
                    params
                );

                return r.rows[0] || undefined;
            },


            async all(...params) {

                const r = await query(
                    pgSql(sql),
                    params
                );

                return r.rows;
            },


            async run(...params) {

                let text = String(sql);

                if (
                    /^\s*INSERT\s+INTO\s+/i.test(text) &&
                    !(/\bRETURNING\b/i.test(text))
                ) {

                    text += ' RETURNING id';

                }

                const r = await query(
                    pgSql(text),
                    params
                );

                return {

                    lastInsertRowid:
                        r.rows[0]?.id ?? null,

                    changes:
                        r.rowCount

                };

            }

        };

    }

};


async function initDatabase() {

    const schema = fs.readFileSync(
        path.join(
            ROOT,
            'backend',
            'schema.sql'
        ),
        'utf8'
    );

    await query(schema);

}


const secretFile =
    path.join(
        DATA,
        '.secret'
    );


if (
    !process.env.JWT_SECRET &&
    !fs.existsSync(secretFile)
) {

    fs.writeFileSync(
        secretFile,
        crypto.randomBytes(32).toString('hex'),
        {
            mode: 0o600
        }
    );

}


const SECRET =
    process.env.JWT_SECRET ||
    fs.readFileSync(
        secretFile,
        'utf8'
    );


const b64 =
    x =>
        Buffer
            .from(x)
            .toString('base64url');


const sign =
    x =>
        crypto
            .createHmac(
                'sha256',
                SECRET
            )
            .update(x)
            .digest('base64url');


const makeToken =
    u => {

        const p =
            b64(
                JSON.stringify({
                    id: u.id,
                    role: u.role,
                    exp:
                        Date.now() +
                        7 * 864e5
                })
            );

        return (
            p +
            '.' +
            sign(p)
        );

    };


function readToken(req) {

    const t =
        (
            req.headers.authorization ||
            ''
        ).replace(
            /^Bearer /,
            ''
        );

    const a = t.split('.');

    if (a.length !== 2) {
        return null;
    }

    const [p, s] = a;

    if (
        !s ||
        s.length !== sign(p).length ||
        !crypto.timingSafeEqual(
            Buffer.from(s),
            Buffer.from(sign(p))
        )
    ) {

        return null;

    }

    try {

        const d =
            JSON.parse(
                Buffer.from(
                    p,
                    'base64url'
                )
            );

        return d.exp > Date.now()
            ? d
            : null;

    } catch {

        return null;

    }

}


const hash = pw => {

    const s =
        crypto.randomBytes(16);

    return (
        s.toString('hex') +
        ':' +
        crypto
            .scryptSync(
                pw,
                s,
                64
            )
            .toString('hex')
    );

};


const verify = (pw, st) => {

    try {

        const [s, h] =
            st.split(':');

        return crypto.timingSafeEqual(
            crypto.scryptSync(
                pw,
                Buffer.from(
                    s,
                    'hex'
                ),
                64
            ),
            Buffer.from(
                h,
                'hex'
            )
        );

    } catch {

        return false;

    }

};


class HttpError extends Error {

    constructor(
        code,
        msg
    ) {

        super(msg);

        this.code = code;

    }

}


const send = (
    res,
    code,
    obj
) => {

    res.writeHead(
        code,
        {
            'Content-Type':
                'application/json',

            'Cache-Control':
                'no-store'
        }
    );

    res.end(
        JSON.stringify(obj)
    );

};


const body = req =>
    new Promise(
        (ok, no) => {

            let d = '';

            req.on(
                'data',
                c => {

                    d += c;

                    if (
                        d.length >
                        50000
                    ) {

                        no(
                            new HttpError(
                                413,
                                'Payload too large'
                            )
                        );

                        req.destroy();

                    }

                }
            );

            req.on(
                'end',
                () => {

                    try {

                        ok(
                            d
                                ? JSON.parse(d)
                                : {}
                        );

                    } catch {

                        no(
                            new HttpError(
                                400,
                                'Invalid JSON'
                            )
                        );

                    }

                }
            );

        }
    );


const str = (
    v,
    min,
    max,
    l
) => {

    v =
        typeof v === 'string'
            ? v.trim()
            : '';

    if (
        v.length < min ||
        v.length > max
    ) {

        throw new HttpError(
            400,
            `${l} must be ${min}-${max} characters`
        );

    }

    return v;

};


const num = (
    v,
    min,
    max,
    l
) => {

    v = Number(v);

    if (
        !Number.isFinite(v) ||
        v < min ||
        v > max
    ) {

        throw new HttpError(
            400,
            `${l} must be ${min}-${max}`
        );

    }

    return v;

};


const need = u => {

    if (!u) {

        throw new HttpError(
            401,
            'Please sign in first'
        );

    }

    return u;

};


async function user(req) {

    const t =
        need(
            readToken(req)
        );

    return await db
        .prepare(
            'SELECT id,username,role,email,phone FROM users WHERE id=?'
        )
        .get(t.id) ||
        need(null);

}


function admin(req) {

    const t =
        need(
            readToken(req)
        );

    if (t.role !== 'admin') {

        throw new HttpError(
            403,
            'Admins only'
        );

    }

    return t;

}


async function notify(
    uid,
    title,
    message
) {

    if (uid) {

        await db
            .prepare(
                'INSERT INTO notifications(user_id,title,message) VALUES(?,?,?)'
            )
            .run(
                uid,
                title,
                message
            );

    }

}


const vapidFile =
    path.join(
        DATA,
        'vapid.json'
    );


if (webpush) {

    try {

        let v =
            fs.existsSync(vapidFile)
                ? JSON.parse(
                    fs.readFileSync(
                        vapidFile,
                        'utf8'
                    )
                )
                : null;

        if (!v) {

            v =
                webpush.generateVAPIDKeys();

            fs.writeFileSync(
                vapidFile,
                JSON.stringify(
                    v,
                    null,
                    2
                ),
                {
                    mode: 0o600
                }
            );

        }

        webpush.setVapidDetails(
            process.env.VAPID_SUBJECT ||
            'mailto:admin@cupandslice.local',

            v.publicKey,

            v.privateKey
        );

    } catch (e) {

        console.error(
            'Push setup warning:',
            e.message
        );

    }

}


async function pushToUsers(
    userIds,
    title,
    message
) {

    if (!webpush) {
        return;
    }

    const ids =
        [
            ...new Set(
                userIds
                    .map(Number)
                    .filter(Boolean)
            )
        ];

    if (!ids.length) {
        return;
    }

    const rows =
        await db
            .prepare(
                `SELECT *
                 FROM push_subscriptions
                 WHERE user_id IN
                 (${ids.map(() => '?').join(',')})`
            )
            .all(...ids);

    for (const r of rows) {

        try {

            await webpush.sendNotification(
                {
                    endpoint:
                        r.endpoint,

                    keys: {
                        p256dh:
                            r.p256dh,

                        auth:
                            r.auth
                    }
                },

                JSON.stringify({
                    title,
                    message,
                    url:
                        '/dashboard.html'
                })
            );

        } catch (e) {

            if (
                e.statusCode === 404 ||
                e.statusCode === 410
            ) {

                await db
                    .prepare(
                        'DELETE FROM push_subscriptions WHERE id=?'
                    )
                    .run(r.id);

            }

        }

    }

}


async function notifyUsers(
    userIds,
    title,
    message
) {

    const ids =
        [
            ...new Set(
                userIds
                    .map(Number)
                    .filter(Boolean)
            )
        ];

    for (const id of ids) {

        await notify(
            id,
            title,
            message
        );

    }

    await pushToUsers(
        ids,
        title,
        message
    );

}


async function order(id) {

    return await db
        .prepare(
            `SELECT
                o.*,
                m.name item,
                m.category,
                u.username,
                u.email,
                u.phone
             FROM orders o
             JOIN menu m
                ON m.id=o.item_id
             LEFT JOIN users u
                ON u.id=o.user_id
             WHERE o.id=?`
        )
        .get(id);

}


async function razorFetch(
    endpoint,
    method,
    payload
) {

    const key =
        process.env.RAZORPAY_KEY_ID;

    const secret =
        process.env.RAZORPAY_KEY_SECRET;

    if (
        !key ||
        !secret
    ) {

        throw new HttpError(
            503,
            'Online payment is not configured yet. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env.'
        );

    }

    const auth =
        Buffer
            .from(
                key +
                ':' +
                secret
            )
            .toString('base64');

    const r =
        await fetch(
            'https://api.razorpay.com/v1/' +
            endpoint,
            {
                method,

                headers: {
                    'Authorization':
                        'Basic ' +
                        auth,

                    'Content-Type':
                        'application/json'
                },

                body:
                    payload
                        ? JSON.stringify(payload)
                        : undefined
            }
        );

    const j =
        await r.json();

    if (!r.ok) {

        throw new HttpError(
            502,
            j.error?.description ||
            'Payment gateway error'
        );

    }

    return j;

}


const razorConfigured =
    () =>
        Boolean(
            process.env.RAZORPAY_KEY_ID &&
            process.env.RAZORPAY_KEY_SECRET
        );


const labels = {

    pending: [
        'Order received 📥',
        'We received your order and sent it to the cafe.'
    ],

    confirmed: [
        'Order accepted 🎉',
        'The cafe accepted your order.'
    ],

    preparing: [
        'Order is being prepared 👨‍🍳',
        'Your food is being prepared now.'
    ],

    ready: [
        'Order ready 🍕',
        'Your order is ready for pickup/delivery.'
    ],

    out_for_delivery: [
        'Out for delivery 🛵',
        'Your order is on the way.'
    ],

    delivered: [
        'Order delivered ✅',
        'Enjoy your order! You can now rate your experience.'
    ],

    cancelled: [
        'Order cancelled ❌',
        'Your order was cancelled.'
    ]

};


const allowed = [
    'pending',
    'confirmed',
    'preparing',
    'ready',
    'out_for_delivery',
    'delivered',
    'cancelled'
];


const nowIso =
    () =>
        new Date().toISOString();


async function addHistory(
    orderId,
    status,
    eta,
    reason
) {

    await db
        .prepare(
            `INSERT INTO order_status_history
             (order_id,status,eta_minutes,reason)
             VALUES(?,?,?,?)`
        )
        .run(
            orderId,
            status,
            eta || null,
            reason || null
        );

}


async function customerIds() {

    return (
        await db
            .prepare(
                "SELECT id FROM users WHERE role='customer'"
            )
            .all()
    ).map(
        x => x.id
    );

}
const routes = {

    'GET /api/health': async () => ({
        status: 'ok',
        backend: true,
        database: true,
        version: '2.0-order-system'
    }),


    'GET /api/config': async () => ({
        cafeName: 'Cup & Slice',
        currency: 'INR',
        taxPercent: 5,
        defaultEta: 35,

        upiId:
            process.env.UPI_ID || '',

        paymentPhone:
            process.env.PAYMENT_PHONE || '',

        paymentQr:
            '/payment-qr.png',

        supportedPayments: [
            'Cash on Delivery',
            'Pay at Cafe',
            'UPI / Google Pay (QR + UTR)',
            'PhonePe (QR + UTR)',
            'Paytm (QR + UTR)',
            'Razorpay Card / UPI / Netbanking'
        ],

        razorpay: {
            enabled:
                razorConfigured(),

            keyId:
                process.env.RAZORPAY_KEY_ID ||
                null
        },

        languages: [
            'English',
            'Hindi',
            'Marathi',
            'French',
            'Spanish',
            'German'
        ],

        currencies: [
            'INR',
            'USD',
            'EUR',
            'GBP'
        ]
    }),


    'GET /api/menu': async () => {

        return await db
            .prepare(
                `SELECT id,name,category,price
                 FROM menu
                 ORDER BY id`
            )
            .all();

    },


    'GET /api/setup/status': async () => {

        const r =
            await db
                .prepare(
                    `SELECT id
                     FROM users
                     WHERE role='admin'
                     LIMIT 1`
                )
                .get();

        return {
            setupRequired: !r
        };

    },


    'POST /api/setup/create-owner': async req => {

        const exists =
            await db
                .prepare(
                    `SELECT id
                     FROM users
                     WHERE role='admin'
                     LIMIT 1`
                )
                .get();

        if (exists) {

            throw new HttpError(
                409,
                'Owner account already exists.'
            );

        }

        const b =
            await body(req);

        const username =
            str(
                b.username,
                3,
                30,
                'Owner User ID'
            );

        const password =
            str(
                b.password,
                8,
                100,
                'Owner Password'
            );

        const email =
            str(
                b.email || '',
                0,
                120,
                'Email'
            );

        const phone =
            str(
                b.phone || '',
                0,
                20,
                'Mobile'
            );

        if (
            !/^[\w.-]+$/.test(username)
        ) {

            throw new HttpError(
                400,
                'User ID may use letters, numbers, . _ -'
            );

        }

        if (
            email &&
            !/^\S+@\S+\.\S+$/.test(email)
        ) {

            throw new HttpError(
                400,
                'Invalid email'
            );

        }

        try {

            const r =
                await db
                    .prepare(
                        `INSERT INTO users
                        (username,pass,role,email,phone)
                        VALUES(?,?,?,?,?)
                        RETURNING id`
                    )
                    .run(
                        username,
                        hash(password),
                        'admin',
                        email || null,
                        phone || null
                    );

            return {
                ok: true,
                id: Number(
                    r.lastInsertRowid
                ),
                username,
                role: 'admin',
                message:
                    'Owner account created. Please sign in from Admin Panel.'
            };

        } catch {

            throw new HttpError(
                409,
                'User ID already exists'
            );

        }

    },


    'POST /api/auth/register': async req => {

        const b =
            await body(req);

        const username =
            str(
                b.username,
                3,
                30,
                'User ID'
            );

        const password =
            str(
                b.password,
                8,
                100,
                'Password'
            );

        const email =
            str(
                b.email || '',
                0,
                120,
                'Email'
            );

        const phone =
            str(
                b.phone || '',
                0,
                20,
                'Mobile'
            );

        if (
            !/^[\w.-]+$/.test(username)
        ) {

            throw new HttpError(
                400,
                'User ID may use letters, numbers, . _ -'
            );

        }

        if (
            email &&
            !/^\S+@\S+\.\S+$/.test(email)
        ) {

            throw new HttpError(
                400,
                'Invalid email'
            );

        }

        try {

            const r =
                await db
                    .prepare(
                        `INSERT INTO users
                        (username,pass,role,email,phone)
                        VALUES(?,?,?,?,?)
                        RETURNING id`
                    )
                    .run(
                        username,
                        hash(password),
                        'customer',
                        email || null,
                        phone || null
                    );

            const u = {
                id: Number(
                    r.lastInsertRowid
                ),
                role: 'customer'
            };

            await notify(
                u.id,
                'Welcome to Cup & Slice ☕🍕',
                'Your account is ready. You can order from our menu.'
            );

            return {
                token:
                    makeToken(u),

                username,
                role: 'customer',
                email,
                phone
            };

        } catch {

            throw new HttpError(
                409,
                'User ID already exists'
            );

        }

    },


    'POST /api/auth/login': async req => {

        const b =
            await body(req);

        const u =
            await db
                .prepare(
                    'SELECT * FROM users WHERE username=?'
                )
                .get(
                    String(
                        b.username || ''
                    )
                );

        if (
            !u ||
            !verify(
                String(
                    b.password || ''
                ),
                u.pass
            )
        ) {

            throw new HttpError(
                401,
                'Wrong User ID or password'
            );

        }

        return {
            token:
                makeToken(u),

            username:
                u.username,

            role:
                u.role,

            email:
                u.email || '',

            phone:
                u.phone || ''
        };

    },


    'GET /api/auth/me': async req => {

        return await user(req);

    },


    'PUT /api/auth/profile': async req => {

        const u =
            await user(req);

        const b =
            await body(req);

        const email =
            str(
                b.email || '',
                0,
                120,
                'Email'
            );

        const phone =
            str(
                b.phone || '',
                0,
                20,
                'Mobile'
            );

        await db
            .prepare(
                `UPDATE users
                 SET email=?,phone=?
                 WHERE id=?`
            )
            .run(
                email || null,
                phone || null,
                u.id
            );

        return await user(req);

    },


    'POST /api/orders': async req => {

        const b =
            await body(req);

        const t =
            need(
                readToken(req)
            );

        const qty =
            num(
                b.qty,
                1,
                50,
                'Quantity'
            );

        const item =
            await db
                .prepare(
                    'SELECT * FROM menu WHERE name=?'
                )
                .get(
                    str(
                        b.item,
                        1,
                        60,
                        'Item'
                    )
                );

        if (!item) {

            throw new HttpError(
                404,
                'Item not found'
            );

        }

        const orderType =
            [
                'delivery',
                'pickup',
                'dine-in'
            ].includes(
                b.orderType
            )
                ? b.orderType
                : 'delivery';

        const payment =
            [
                'cod',
                'pay_at_cafe',
                'upi',
                'phonepe',
                'paytm',
                'card_paypal'
            ].includes(
                b.paymentMethod
            )
                ? b.paymentMethod
                : 'cod';

        const address =
            orderType === 'delivery'
                ? str(
                    b.address,
                    5,
                    250,
                    'Address'
                )
                : str(
                    b.address ||
                    'Not required',
                    1,
                    250,
                    'Address'
                );

        const customerName =
            str(
                b.customerName ||
                t.username,
                2,
                80,
                'Customer name'
            );

        const tableNo =
            str(
                b.tableNo || '',
                0,
                30,
                'Table number'
            );

        const source =
            str(
                b.orderSource ||
                'Direct Website',
                2,
                60,
                'Order source'
            );

        const subtotal =
            Number(item.price) *
            qty;

        const tax =
            Math.round(
                subtotal *
                0.05 *
                100
            ) / 100;

        const tip =
            Math.max(
                0,
                Number(b.tip) || 0
            );

        const total =
            subtotal +
            tax +
            tip;

        const eta =
            orderType === 'pickup'
                ? 20
                : 35;

        const paymentRef =
            str(
                b.paymentRef || '',
                0,
                100,
                'Payment reference'
            ) || null;

        const notes =
            str(
                b.notes || '',
                0,
                500,
                'Notes'
            );

        const r =
            await db
                .prepare(
                    `INSERT INTO orders
                    (
                        user_id,
                        item_id,
                        qty,
                        total,
                        status,
                        customer_name,
                        table_no,
                        address,
                        order_source,
                        order_type,
                        payment_method,
                        payment_status,
                        payment_ref,
                        eta_minutes,
                        notes,
                        currency,
                        tax,
                        tip
                    )
                    VALUES
                    (
                        ?,?,?,?,?,?,?,?,?,?,
                        ?,?,?,?,?,?,?,?
                    )
                    RETURNING id`
                )
                .run(
                    t.id,
                    item.id,
                    qty,
                    total,
                    'pending',
                    customerName,
                    tableNo,
                    address,
                    source,
                    orderType,
                    payment,
                    'pending',
                    paymentRef,
                    eta,
                    notes,
                    'INR',
                    tax,
                    tip
                );

        const o =
            await order(
                Number(
                    r.lastInsertRowid
                )
            );

        await notify(
            t.id,
            'Order received 📥',
            `Order #${o.id} received. ETA about ${eta} minutes. Waiting for cafe confirmation.`
        );

        await db
            .prepare(
                `INSERT INTO notifications
                (user_id,title,message)
                SELECT
                    id,
                    ?,
                    ?
                FROM users
                WHERE role='admin'`
            )
            .run(
                '🔔 New order received',
                `Order #${o.id}: ${customerName} | Table ${tableNo || 'N/A'} | ${item.name} × ${qty} | ₹${total} | ${orderType} | ${address}`
            );

        return {
            order: o,

            notification:
                'Order received',

            etaMinutes:
                eta,

            paymentInstruction:
                [
                    'upi',
                    'phonepe',
                    'paytm'
                ].includes(payment)
                    ? `Pay using ${payment}. UPI ID: ${process.env.UPI_ID || 'Not configured'} | Mobile: ${process.env.PAYMENT_PHONE || 'Not configured'}`
                    : null
        };

    },


    'GET /api/orders': async req => {

        const t =
            need(
                readToken(req)
            );

        return await db
            .prepare(
                `SELECT
                    o.*,
                    m.name item,
                    f.rating,
                    f.comment
                 FROM orders o
                 JOIN menu m
                    ON m.id=o.item_id
                 LEFT JOIN feedback f
                    ON f.order_id=o.id
                 WHERE o.user_id=?
                 ORDER BY o.id DESC`
            )
            .all(
                t.id
            );

    },


    'GET /api/orders/tracking': async req => {

        const t =
            need(
                readToken(req)
            );

        return await db
            .prepare(
                `SELECT
                    o.id,
                    o.status,
                    o.eta_minutes,
                    o.eta_until,
                    o.order_type,
                    o.address,
                    o.delivery_lat,
                    o.delivery_lng,
                    o.delivery_accuracy,
                    o.location_updated_at,
                    m.name item
                 FROM orders o
                 JOIN menu m
                    ON m.id=o.item_id
                 WHERE
                    o.user_id=?
                    AND o.status IN
                    (
                        'confirmed',
                        'preparing',
                        'ready',
                        'out_for_delivery'
                    )
                 ORDER BY o.id DESC`
            )
            .all(
                t.id
            );

    },


    'PUT /api/orders/cancel': async req => {

        const t =
            need(
                readToken(req)
            );

        const b =
            await body(req);

        const o =
            await order(
                num(
                    b.orderId,
                    1,
                    999999999,
                    'Order ID'
                )
            );

        if (
            !o ||
            Number(o.user_id) !==
                Number(t.id)
        ) {

            throw new HttpError(
                404,
                'Order not found'
            );

        }

        if (
            ![
                'pending',
                'confirmed'
            ].includes(
                o.status
            )
        ) {

            throw new HttpError(
                400,
                'This order can no longer be cancelled'
            );

        }

        const reason =
            str(
                b.reason ||
                'Cancelled by customer',
                3,
                250,
                'Reason'
            );

        await db
            .prepare(
                `UPDATE orders
                 SET
                    status='cancelled',
                    cancel_reason=?,
                    eta_minutes=0,
                    eta_until=NULL
                 WHERE id=?`
            )
            .run(
                reason,
                o.id
            );

        await addHistory(
            o.id,
            'cancelled',
            0,
            reason
        );

        await notify(
            t.id,
            'Order cancelled ❌',
            `Order #${o.id} has been cancelled.`
        );

        return {
            ok: true
        };

    },


    'GET /api/notifications': async req => {

        const t =
            need(
                readToken(req)
            );

        return await db
            .prepare(
                `SELECT *
                 FROM notifications
                 WHERE user_id=?
                 ORDER BY id DESC
                 LIMIT 100`
            )
            .all(
                t.id
            );

    },


    'PUT /api/notifications/read': async req => {

        const t =
            need(
                readToken(req)
            );

        const b =
            await body(req);

        if (b.all) {

            await db
                .prepare(
                    `UPDATE notifications
                     SET is_read=1
                     WHERE user_id=?`
                )
                .run(
                    t.id
                );

        } else {

            await db
                .prepare(
                    `UPDATE notifications
                     SET is_read=1
                     WHERE id=?
                     AND user_id=?`
                )
                .run(
                    num(
                        b.id,
                        1,
                        999999999,
                        'Notification ID'
                    ),
                    t.id
                );

        }

        return {
            ok: true
        };

    },


    'POST /api/feedback': async req => {

        const t =
            need(
                readToken(req)
            );

        const b =
            await body(req);

        const o =
            await order(
                num(
                    b.orderId,
                    1,
                    999999999,
                    'Order ID'
                )
            );

        if (
            !o ||
            Number(o.user_id) !==
                Number(t.id)
        ) {

            throw new HttpError(
                404,
                'Order not found'
            );

        }

        if (
            o.status !==
            'delivered'
        ) {

            throw new HttpError(
                400,
                'Feedback is available after delivery'
            );

        }

        const rating =
            num(
                b.rating,
                1,
                5,
                'Rating'
            );

        const comment =
            str(
                b.comment || '',
                0,
                500,
                'Comment'
            );

        try {

            await db
                .prepare(
                    `INSERT INTO feedback
                    (
                        order_id,
                        user_id,
                        rating,
                        comment
                    )
                    VALUES(?,?,?,?)`
                )
                .run(
                    o.id,
                    t.id,
                    rating,
                    comment
                );

        } catch {

            throw new HttpError(
                409,
                'Feedback already submitted'
            );

        }

        return {
            ok: true
        };

    },


    'POST /api/reservations': async req => {

        const b =
            await body(req);

        const at =
            str(
                b.at,
                10,
                40,
                'Date/time'
            );

        const name =
            str(
                b.name,
                2,
                60,
                'Name'
            );

        const people =
            num(
                b.people,
                1,
                50,
                'People'
            );

        const message =
            str(
                b.message || '',
                0,
                500,
                'Message'
            );

        const r =
            await db
                .prepare(
                    `INSERT INTO reservations
                    (
                        name,
                        people,
                        at,
                        message
                    )
                    VALUES(?,?,?,?)
                    RETURNING id`
                )
                .run(
                    name,
                    people,
                    at,
                    message
                );

        const t =
            readToken(req);

        if (t) {

            await notify(
                t.id,
                'Reservation received 📅',
                `Reservation #${r.lastInsertRowid} received.`
            );

        }

        return {
            id:
                Number(
                    r.lastInsertRowid
                ),

            status:
                'received'
        };

    },


    'GET /api/orders/history': async req => {

        const t =
            need(
                readToken(req)
            );

        return await db
            .prepare(
                `SELECT *
                 FROM order_status_history
                 WHERE order_id IN
                 (
                    SELECT id
                    FROM orders
                    WHERE user_id=?
                 )
                 ORDER BY id DESC
                 LIMIT 200`
            )
            .all(
                t.id
            );

    },


    'GET /api/push/public-key': async () => {

        if (!webpush) {

            return {
                enabled: false
            };

        }

        const v =
            JSON.parse(
                fs.readFileSync(
                    vapidFile,
                    'utf8'
                )
            );

        return {
            enabled: true,
            publicKey:
                v.publicKey
        };

    },


    'POST /api/push/subscribe': async req => {

        const t =
            await user(req);

        const b =
            await body(req);

        if (
            !b.endpoint ||
            !b.keys?.p256dh ||
            !b.keys?.auth
        ) {

            throw new HttpError(
                400,
                'Invalid push subscription'
            );

        }

        await db
            .prepare(
                `INSERT INTO push_subscriptions
                (
                    user_id,
                    endpoint,
                    p256dh,
                    auth
                )
                VALUES(?,?,?,?)
                ON CONFLICT(endpoint)
                DO UPDATE SET
                    user_id=EXCLUDED.user_id,
                    p256dh=EXCLUDED.p256dh,
                    auth=EXCLUDED.auth`
            )
            .run(
                t.id,
                str(
                    b.endpoint,
                    10,
                    2000,
                    'Endpoint'
                ),
                str(
                    b.keys.p256dh,
                    10,
                    500,
                    'p256dh'
                ),
                str(
                    b.keys.auth,
                    5,
                    500,
                    'auth'
                )
            );

        return {
            ok: true
        };

    }

};
Object.assign(routes, {

    /* =========================
       ADMIN STATS
    ========================= */

    'GET /api/admin/stats': async req => {

        admin(req);

        const users =
            await db
                .prepare(
                    `SELECT COUNT(*)::int AS count
                     FROM users
                     WHERE role='customer'`
                )
                .get();

        const orders =
            await db
                .prepare(
                    `SELECT COUNT(*)::int AS count
                     FROM orders`
                )
                .get();

        const pending =
            await db
                .prepare(
                    `SELECT COUNT(*)::int AS count
                     FROM orders
                     WHERE status='pending'`
                )
                .get();

        const revenue =
            await db
                .prepare(
                    `SELECT COALESCE(
                        SUM(total),0
                     ) AS total
                     FROM orders
                     WHERE status='delivered'`
                )
                .get();

        const feedback =
            await db
                .prepare(
                    `SELECT COUNT(*)::int AS count
                     FROM feedback`
                )
                .get();

        return {
            users:
                Number(users?.count || 0),

            orders:
                Number(orders?.count || 0),

            pending:
                Number(pending?.count || 0),

            revenue:
                Number(revenue?.total || 0),

            feedback:
                Number(feedback?.count || 0)
        };

    },


    /* =========================
       ADMIN ORDERS
    ========================= */

    'GET /api/admin/orders': async req => {

        admin(req);

        return await db
            .prepare(
                `SELECT
                    o.*,
                    m.name AS item,
                    m.category,
                    u.username,
                    u.email,
                    u.phone
                 FROM orders o
                 JOIN menu m
                   ON m.id=o.item_id
                 LEFT JOIN users u
                   ON u.id=o.user_id
                 ORDER BY
                    CASE
                        WHEN o.status='pending'
                        THEN 0
                        ELSE 1
                    END,
                    o.id DESC`
            )
            .all();

    },


    /* =========================
       ADMIN ORDER STATUS
    ========================= */

    'PUT /api/admin/orders/status': async req => {

        admin(req);

        const b =
            await body(req);

        const orderId =
            num(
                b.orderId,
                1,
                999999999,
                'Order ID'
            );

        const status =
            str(
                b.status,
                1,
                40,
                'Status'
            );

        if (!allowed.includes(status)) {

            throw new HttpError(
                400,
                'Invalid order status'
            );

        }

        const o =
            await order(orderId);

        if (!o) {

            throw new HttpError(
                404,
                'Order not found'
            );

        }

        let eta =
            Number(
                b.etaMinutes ||
                o.eta_minutes ||
                35
            );

        if (
            [
                'delivered',
                'cancelled'
            ].includes(status)
        ) {
            eta = 0;
        }

        let etaUntil = null;

        if (
            eta > 0 &&
            [
                'confirmed',
                'preparing',
                'ready',
                'out_for_delivery'
            ].includes(status)
        ) {

            etaUntil =
                new Date(
                    Date.now() +
                    eta * 60000
                );

        }

        const timestampColumn = {

            confirmed:
                'confirmed_at',

            preparing:
                'preparing_at',

            ready:
                'ready_at',

            out_for_delivery:
                'out_for_delivery_at',

            delivered:
                'delivered_at'

        }[status];


        if (timestampColumn) {

            await db
                .prepare(
                    `UPDATE orders
                     SET
                        status=?,
                        eta_minutes=?,
                        eta_until=?,
                        ${timestampColumn}=CURRENT_TIMESTAMP
                     WHERE id=?`
                )
                .run(
                    status,
                    eta,
                    etaUntil,
                    orderId
                );

        } else {

            await db
                .prepare(
                    `UPDATE orders
                     SET
                        status=?,
                        eta_minutes=?,
                        eta_until=?
                     WHERE id=?`
                )
                .run(
                    status,
                    eta,
                    etaUntil,
                    orderId
                );

        }

        await addHistory(
            orderId,
            status,
            eta,
            null
        );

        const message =
            labels[status] ||
            [
                'Order update',
                `Your order #${orderId} status is ${status}.`
            ];

        await notify(
            o.user_id,
            message[0],
            `Order #${orderId}: ${message[1]}`
        );

        return {
            ok: true,
            orderId,
            status,
            etaMinutes: eta
        };

    },


    /* =========================
       ADMIN ETA
    ========================= */

    'PUT /api/admin/orders/eta': async req => {

        admin(req);

        const b =
            await body(req);

        const orderId =
            num(
                b.orderId,
                1,
                999999999,
                'Order ID'
            );

        const eta =
            num(
                b.etaMinutes,
                0,
                1440,
                'ETA'
            );

        const o =
            await order(orderId);

        if (!o) {

            throw new HttpError(
                404,
                'Order not found'
            );

        }

        const etaUntil =
            eta > 0
                ? new Date(
                    Date.now() +
                    eta * 60000
                )
                : null;

        await db
            .prepare(
                `UPDATE orders
                 SET
                    eta_minutes=?,
                    eta_until=?
                 WHERE id=?`
            )
            .run(
                eta,
                etaUntil,
                orderId
            );

        await notify(
            o.user_id,
            'Estimated time updated ⏱️',
            `Order #${orderId} estimated time is now ${eta} minutes.`
        );

        return {
            ok: true,
            etaMinutes: eta
        };

    },


    /* =========================
       ADMIN CANCEL
    ========================= */

    'PUT /api/admin/orders/cancel': async req => {

        admin(req);

        const b =
            await body(req);

        const orderId =
            num(
                b.orderId,
                1,
                999999999,
                'Order ID'
            );

        const reason =
            str(
                b.reason ||
                'Cancelled by cafe',
                3,
                250,
                'Reason'
            );

        const o =
            await order(orderId);

        if (!o) {

            throw new HttpError(
                404,
                'Order not found'
            );

        }

        await db
            .prepare(
                `UPDATE orders
                 SET
                    status='cancelled',
                    cancel_reason=?,
                    eta_minutes=0,
                    eta_until=NULL
                 WHERE id=?`
            )
            .run(
                reason,
                orderId
            );

        await addHistory(
            orderId,
            'cancelled',
            0,
            reason
        );

        await notify(
            o.user_id,
            'Order cancelled ❌',
            `Order #${orderId} was cancelled. Reason: ${reason}`
        );

        return {
            ok: true
        };

    },


    /* =========================
       ADMIN PAYMENT
    ========================= */

    'PUT /api/admin/orders/payment': async req => {

        admin(req);

        const b =
            await body(req);

        const orderId =
            num(
                b.orderId,
                1,
                999999999,
                'Order ID'
            );

        const paymentStatus =
            str(
                b.paymentStatus,
                2,
                30,
                'Payment status'
            );

        const allowedPaymentStatuses = [
            'pending',
            'paid',
            'failed',
            'refunded',
            'partially_refunded'
        ];

        if (
            !allowedPaymentStatuses.includes(
                paymentStatus
            )
        ) {

            throw new HttpError(
                400,
                'Invalid payment status'
            );

        }

        const o =
            await order(orderId);

        if (!o) {

            throw new HttpError(
                404,
                'Order not found'
            );

        }

        await db
            .prepare(
                `UPDATE orders
                 SET payment_status=?
                 WHERE id=?`
            )
            .run(
                paymentStatus,
                orderId
            );

        await notify(
            o.user_id,
            'Payment update 💳',
            `Payment for order #${orderId} is ${paymentStatus}.`
        );

        return {
            ok: true,
            paymentStatus
        };

    },


    /* =========================
       ADMIN USERS
    ========================= */

    'GET /api/admin/users': async req => {

        admin(req);

        return await db
            .prepare(
                `SELECT
                    id,
                    username,
                    role,
                    email,
                    phone,
                    created
                 FROM users
                 ORDER BY id DESC`
            )
            .all();

    },


    'POST /api/admin/users': async req => {

        admin(req);

        const b =
            await body(req);

        const username =
            str(
                b.username,
                3,
                30,
                'User ID'
            );

        const password =
            str(
                b.password,
                8,
                100,
                'Password'
            );

        const email =
            str(
                b.email || '',
                0,
                120,
                'Email'
            );

        const phone =
            str(
                b.phone || '',
                0,
                20,
                'Mobile'
            );

        const role =
            [
                'customer',
                'admin'
            ].includes(
                b.role
            )
                ? b.role
                : 'customer';

        try {

            const r =
                await db
                    .prepare(
                        `INSERT INTO users
                        (
                            username,
                            pass,
                            role,
                            email,
                            phone
                        )
                        VALUES(?,?,?,?,?)
                        RETURNING id`
                    )
                    .run(
                        username,
                        hash(password),
                        role,
                        email || null,
                        phone || null
                    );

            return {
                ok: true,
                id:
                    Number(
                        r.lastInsertRowid
                    ),
                username,
                role
            };

        } catch {

            throw new HttpError(
                409,
                'User ID already exists'
            );

        }

    },


    /* =========================
       ADMIN MENU
    ========================= */

    'GET /api/admin/menu': async req => {

        admin(req);

        return await db
            .prepare(
                `SELECT *
                 FROM menu
                 ORDER BY id`
            )
            .all();

    },


    'POST /api/admin/menu': async req => {

        admin(req);

        const b =
            await body(req);

        const name =
            str(
                b.name,
                2,
                100,
                'Item name'
            );

        const category =
            str(
                b.category,
                2,
                50,
                'Category'
            );

        const price =
            num(
                b.price,
                0,
                100000,
                'Price'
            );

        try {

            const r =
                await db
                    .prepare(
                        `INSERT INTO menu
                        (
                            name,
                            category,
                            price
                        )
                        VALUES(?,?,?)
                        RETURNING id`
                    )
                    .run(
                        name,
                        category,
                        price
                    );

            return {
                ok: true,
                id:
                    Number(
                        r.lastInsertRowid
                    )
            };

        } catch {

            throw new HttpError(
                409,
                'Menu item already exists'
            );

        }

    },


    'PUT /api/admin/menu': async req => {

        admin(req);

        const b =
            await body(req);

        const id =
            num(
                b.id,
                1,
                999999999,
                'Menu ID'
            );

        const name =
            str(
                b.name,
                2,
                100,
                'Item name'
            );

        const category =
            str(
                b.category,
                2,
                50,
                'Category'
            );

        const price =
            num(
                b.price,
                0,
                100000,
                'Price'
            );

        await db
            .prepare(
                `UPDATE menu
                 SET
                    name=?,
                    category=?,
                    price=?
                 WHERE id=?`
            )
            .run(
                name,
                category,
                price,
                id
            );

        return {
            ok: true
        };

    },


    'DELETE /api/admin/menu': async req => {

        admin(req);

        const b =
            await body(req);

        const id =
            num(
                b.id,
                1,
                999999999,
                'Menu ID'
            );

        const used =
            await db
                .prepare(
                    `SELECT id
                     FROM orders
                     WHERE item_id=?
                     LIMIT 1`
                )
                .get(id);

        if (used) {

            throw new HttpError(
                400,
                'This item is already used in an order. Change its price instead of deleting it.'
            );

        }

        await db
            .prepare(
                'DELETE FROM menu WHERE id=?'
            )
            .run(id);

        return {
            ok: true
        };

    },


    /* =========================
       ADMIN COUPONS
    ========================= */

    'GET /api/admin/coupons': async req => {

        admin(req);

        return await db
            .prepare(
                `SELECT *
                 FROM coupons
                 ORDER BY id DESC`
            )
            .all();

    },


    'POST /api/admin/coupons': async req => {

        admin(req);

        const b =
            await body(req);

        const code =
            str(
                b.code,
                2,
                30,
                'Coupon code'
            ).toUpperCase();

        const discountType =
            [
                'percent',
                'flat'
            ].includes(
                b.discountType
            )
                ? b.discountType
                : 'percent';

        const discountValue =
            num(
                b.discountValue,
                0,
                discountType === 'percent'
                    ? 100
                    : 100000,
                'Discount'
            );

        const minOrder =
            num(
                b.minOrder || 0,
                0,
                1000000,
                'Minimum order'
            );

        const maxUses =
            num(
                b.maxUses || 999999,
                1,
                999999999,
                'Maximum uses'
            );

        try {

            const r =
                await db
                    .prepare(
                        `INSERT INTO coupons
                        (
                            code,
                            discount_type,
                            discount_value,
                            min_order,
                            max_uses,
                            active
                        )
                        VALUES(?,?,?,?,?,1)
                        RETURNING id`
                    )
                    .run(
                        code,
                        discountType,
                        discountValue,
                        minOrder,
                        maxUses
                    );

            return {
                ok: true,
                id:
                    Number(
                        r.lastInsertRowid
                    )
            };

        } catch {

            throw new HttpError(
                409,
                'Coupon already exists'
            );

        }

    },


    /* =========================
       ADMIN NOTIFICATIONS
    ========================= */

    'POST /api/admin/notify': async req => {

        admin(req);

        const b =
            await body(req);

        const title =
            str(
                b.title,
                2,
                120,
                'Title'
            );

        const message =
            str(
                b.message,
                2,
                1000,
                'Message'
            );

        let ids = [];

        if (b.userId) {

            ids = [
                num(
                    b.userId,
                    1,
                    999999999,
                    'Customer ID'
                )
            ];

        } else {

            ids =
                await customerIds();

        }

        await notifyUsers(
            ids,
            title,
            message
        );

        return {
            ok: true,
            sent:
                ids.length
        };

    },


    /* =========================
       ADMIN FEEDBACK
    ========================= */

    'GET /api/admin/feedback': async req => {

        admin(req);

        return await db
            .prepare(
                `SELECT
                    f.*,
                    u.username,
                    m.name AS item
                 FROM feedback f
                 JOIN users u
                   ON u.id=f.user_id
                 JOIN orders o
                   ON o.id=f.order_id
                 JOIN menu m
                   ON m.id=o.item_id
                 ORDER BY f.id DESC`
            )
            .all();

    },


    /* =========================
       ADMIN RESERVATIONS
    ========================= */

    'GET /api/admin/reservations': async req => {

        admin(req);

        return await db
            .prepare(
                `SELECT *
                 FROM reservations
                 ORDER BY id DESC`
            )
            .all();

    },


    /* =========================
       RAZORPAY CREATE ORDER
    ========================= */

    'POST /api/payments/razorpay/create': async req => {

        const t =
            need(
                readToken(req)
            );

        const b =
            await body(req);

        const orderId =
            num(
                b.orderId,
                1,
                999999999,
                'Order ID'
            );

        const o =
            await order(orderId);

        if (
            !o ||
            Number(o.user_id) !==
                Number(t.id)
        ) {

            throw new HttpError(
                404,
                'Order not found'
            );

        }

        if (
            o.payment_method !==
            'card_paypal'
        ) {

            throw new HttpError(
                400,
                'This order is not using gateway payment'
            );

        }

        if (
            !razorConfigured()
        ) {

            throw new HttpError(
                503,
                'Razorpay is not configured'
            );

        }

        const rp =
            await razorFetch(
                'orders',
                'POST',
                {
                    amount:
                        Math.round(
                            Number(o.total) *
                            100
                        ),

                    currency:
                        'INR',

                    receipt:
                        `cup-slice-${o.id}`,

                    notes: {
                        orderId:
                            String(o.id),

                        userId:
                            String(t.id)
                    }
                }
            );

        await db
            .prepare(
                `UPDATE orders
                 SET gateway_order_id=?
                 WHERE id=?`
            )
            .run(
                rp.id,
                o.id
            );

        return {
            ok: true,

            keyId:
                process.env.RAZORPAY_KEY_ID,

            gatewayOrderId:
                rp.id,

            amount:
                rp.amount,

            currency:
                rp.currency
        };

    },


    /* =========================
       RAZORPAY VERIFY
    ========================= */

    'POST /api/payments/razorpay/verify': async req => {

        const t =
            need(
                readToken(req)
            );

        const b =
            await body(req);

        const orderId =
            num(
                b.orderId,
                1,
                999999999,
                'Order ID'
            );

        const o =
            await order(orderId);

        if (
            !o ||
            Number(o.user_id) !==
                Number(t.id)
        ) {

            throw new HttpError(
                404,
                'Order not found'
            );

        }

        const gatewayOrderId =
            str(
                b.razorpayOrderId,
                5,
                200,
                'Gateway order ID'
            );

        const paymentId =
            str(
                b.razorpayPaymentId,
                5,
                200,
                'Payment ID'
            );

        const signature =
            str(
                b.razorpaySignature,
                10,
                500,
                'Signature'
            );

        const expected =
            crypto
                .createHmac(
                    'sha256',
                    process.env.RAZORPAY_KEY_SECRET || ''
                )
                .update(
                    gatewayOrderId +
                    '|' +
                    paymentId
                )
                .digest('hex');

        if (
            signature !== expected
        ) {

            throw new HttpError(
                400,
                'Payment signature verification failed'
            );

        }

        await db
            .prepare(
                `UPDATE orders
                 SET
                    payment_status='paid',
                    payment_ref=?,
                    gateway_order_id=?,
                    gateway_payment_id=?,
                    gateway_signature=?
                 WHERE id=?`
            )
            .run(
                paymentId,
                gatewayOrderId,
                paymentId,
                signature,
                orderId
            );

        await notify(
            t.id,
            'Payment successful 💳',
            `Payment for order #${orderId} was verified successfully.`
        );

        return {
            ok: true,
            paymentStatus: 'paid'
        };

    },


    /* =========================
       DELIVERY LOCATION
    ========================= */

    'POST /api/delivery/location': async req => {

        const t =
            await user(req);

        const b =
            await body(req);

        const orderId =
            num(
                b.orderId,
                1,
                999999999,
                'Order ID'
            );

        const lat =
            num(
                b.lat,
                -90,
                90,
                'Latitude'
            );

        const lng =
            num(
                b.lng,
                -180,
                180,
                'Longitude'
            );

        const accuracy =
            Number(
                b.accuracy || 0
            );

        const o =
            await order(orderId);

        if (
            !o ||
            Number(o.user_id) !==
                Number(t.id)
        ) {

            throw new HttpError(
                404,
                'Order not found'
            );

        }

        if (
            o.status !==
            'out_for_delivery'
        ) {

            throw new HttpError(
                400,
                'Location sharing is available only during active delivery'
            );

        }

        await db
            .prepare(
                `INSERT INTO delivery_locations
                (
                    order_id,
                    user_id,
                    lat,
                    lng,
                    accuracy
                )
                VALUES(?,?,?,?,?)`
            )
            .run(
                orderId,
                t.id,
                lat,
                lng,
                accuracy
            );

        await db
            .prepare(
                `UPDATE orders
                 SET
                    delivery_lat=?,
                    delivery_lng=?,
                    delivery_accuracy=?,
                    location_updated_at=CURRENT_TIMESTAMP
                 WHERE id=?`
            )
            .run(
                lat,
                lng,
                accuracy,
                orderId
            );

        return {
            ok: true
        };

    },


    'GET /api/orders/location': async req => {

        const t =
            need(
                readToken(req)
            );

        const b =
            new URL(
                req.url,
                'http://localhost'
            );

        const orderId =
            num(
                b.searchParams.get(
                    'orderId'
                ),
                1,
                999999999,
                'Order ID'
            );

        const o =
            await order(orderId);

        if (
            !o ||
            Number(o.user_id) !==
                Number(t.id)
        ) {

            throw new HttpError(
                404,
                'Order not found'
            );

        }

        return await db
            .prepare(
                `SELECT
                    lat,
                    lng,
                    accuracy,
                    created
                 FROM delivery_locations
                 WHERE order_id=?
                 ORDER BY id DESC
                 LIMIT 1`
            )
            .get(
                orderId
            ) || null;

    },


    'GET /api/delivery/orders': async req => {

        admin(req);

        return await db
            .prepare(
                `SELECT
                    o.id,
                    o.status,
                    o.address,
                    o.delivery_lat,
                    o.delivery_lng,
                    o.delivery_accuracy,
                    o.location_updated_at,
                    o.eta_minutes,
                    o.eta_until,
                    u.username,
                    u.phone
                 FROM orders o
                 LEFT JOIN users u
                   ON u.id=o.user_id
                 WHERE o.status='out_for_delivery'
                 ORDER BY o.id DESC`
            )
            .all();

    }

});


/* =========================
   STATIC FILE SERVER
========================= */

const mime = {

    '.html':
        'text/html; charset=utf-8',

    '.css':
        'text/css; charset=utf-8',

    '.js':
        'application/javascript; charset=utf-8',

    '.json':
        'application/json; charset=utf-8',

    '.png':
        'image/png',

    '.jpg':
        'image/jpeg',

    '.jpeg':
        'image/jpeg',

    '.svg':
        'image/svg+xml',

    '.ico':
        'image/x-icon',

    '.webp':
        'image/webp',

    '.woff':
        'font/woff',

    '.woff2':
        'font/woff2',

    '.txt':
        'text/plain; charset=utf-8',

    '.manifest':
        'application/manifest+json'
};


function safeFilePath(
    urlPath
) {

    let decoded;

    try {

        decoded =
            decodeURIComponent(
                urlPath
            );

    } catch {

        return null;

    }

    decoded =
        decoded
            .replace(
                /^\/+/,
                ''
            )
            .replace(
                /\\/g,
                '/'
            );

    const full =
        path.resolve(
            PUBLIC,
            decoded
        );

    const root =
        path.resolve(
            PUBLIC
        );

    if (
        full !== root &&
        !full.startsWith(
            root + path.sep
        )
    ) {

        return null;

    }

    return full;

}


async function serveStatic(
    req,
    res
) {

    let urlPath =
        new URL(
            req.url,
            'http://localhost'
        ).pathname;

    if (
        urlPath === '/'
    ) {

        urlPath =
            '/index.html';

    }

    const file =
        safeFilePath(
            urlPath
        );

    if (!file) {

        send(
            res,
            403,
            {
                error:
                    'Forbidden'
            }
        );

        return;

    }

    try {

        const stat =
            fs.statSync(file);

        if (
            stat.isDirectory()
        ) {

            return serveStatic(
                {
                    ...req,
                    url:
                        urlPath +
                        '/index.html'
                },
                res
            );

        }

        const ext =
            path.extname(
                file
            ).toLowerCase();

        res.writeHead(
            200,
            {
                'Content-Type':
                    mime[ext] ||
                    'application/octet-stream',

                'Cache-Control':
                    ext === '.html'
                        ? 'no-cache'
                        : 'public, max-age=3600'
            }
        );

        fs.createReadStream(
            file
        ).pipe(res);

    } catch {

        if (
            urlPath !==
            '/index.html'
        ) {

            const index =
                path.join(
                    PUBLIC,
                    'index.html'
                );

            try {

                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'text/html; charset=utf-8'
                    }
                );

                fs.createReadStream(
                    index
                ).pipe(res);

                return;

            } catch {}

        }

        send(
            res,
            404,
            {
                error:
                    'File not found'
            }
        );

    }

}


/* =========================
   RATE LIMIT
========================= */

const rateMap =
    new Map();


function rateLimit(
    req,
    res
) {

    const ip =
        req.socket.remoteAddress ||
        'unknown';

    const now =
        Date.now();

    const old =
        rateMap.get(ip);

    if (
        !old ||
        now - old.start >
        60_000
    ) {

        rateMap.set(
            ip,
            {
                start: now,
                count: 1
            }
        );

        return true;

    }

    old.count++;

    if (
        old.count > 240
    ) {

        send(
            res,
            429,
            {
                error:
                    'Too many requests. Please try again later.'
            }
        );

        return false;

    }

    return true;

}


setInterval(
    () => {

        const now =
            Date.now();

        for (
            const [
                ip,
                v
            ] of rateMap
        ) {

            if (
                now - v.start >
                120_000
            ) {

                rateMap.delete(ip);

            }

        }

    },
    120_000
);


/* =========================
   HTTP SERVER
========================= */

const server =
    http.createServer(
        async (
            req,
            res
        ) => {

            try {

                if (
                    !rateLimit(
                        req,
                        res
                    )
                ) {

                    return;

                }

                const parsed =
                    new URL(
                        req.url,
                        `http://${req.headers.host || 'localhost'}`
                    );

                const pathname =
                    parsed.pathname;

                const method =
                    req.method.toUpperCase();

                const key =
                    method +
                    ' ' +
                    pathname;

                const handler =
                    routes[key];

                if (handler) {

                    const result =
                        await handler(req);

                    send(
                        res,
                        200,
                        result
                    );

                    return;

                }

                if (
                    pathname.startsWith(
                        '/api/'
                    )
                ) {

                    send(
                        res,
                        404,
                        {
                            error:
                                'API route not found'
                        }
                    );

                    return;

                }

                await serveStatic(
                    req,
                    res
                );

            } catch (e) {

                console.error(
                    e
                );

                const code =
                    e instanceof HttpError
                        ? e.code
                        : 500;

                send(
                    res,
                    code,
                    {
                        error:
                            e.message ||
                            'Server error'
                    }
                );

            }

        }
    );


async function start() {

    try {

        await initDatabase();

        console.log(
            'PostgreSQL database initialized.'
        );

        server.listen(
            PORT,
            '0.0.0.0',
            () => {

                console.log(
                    `Cup & Slice PostgreSQL server running at http://localhost:${PORT}`
                );

                console.log(
                    `Health check: http://localhost:${PORT}/api/health`
                );

            }
        );

    } catch (e) {

        console.error(
            'SERVER START FAILED:',
            e
        );

        process.exit(
            1
        );

    }

}


process.on(
    'SIGINT',
    async () => {

        try {

            await close();

        } finally {

            process.exit(0);

        }

    }
);


process.on(
    'SIGTERM',
    async () => {

        try {

            await close();

        } finally {

            process.exit(0);

        }

    }
);


start();