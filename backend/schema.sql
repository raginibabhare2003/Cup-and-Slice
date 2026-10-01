CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    pass TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    email TEXT,
    phone TEXT,
    created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx
ON users (LOWER(username));


CREATE TABLE IF NOT EXISTS menu (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    price NUMERIC(12,2) NOT NULL
);


CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id),
    item_id BIGINT NOT NULL REFERENCES menu(id),
    qty INTEGER NOT NULL,
    total NUMERIC(12,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    customer_name TEXT,
    table_no TEXT,
    address TEXT,
    order_source TEXT DEFAULT 'Direct Website',
    order_type TEXT DEFAULT 'delivery',

    payment_method TEXT DEFAULT 'cod',
    payment_status TEXT DEFAULT 'pending',
    payment_ref TEXT,

    eta_minutes INTEGER DEFAULT 35,
    eta_until TIMESTAMPTZ,

    notes TEXT,
    cancel_reason TEXT,

    currency TEXT DEFAULT 'INR',
    tax NUMERIC(12,2) DEFAULT 0,
    tip NUMERIC(12,2) DEFAULT 0,

    gateway_order_id TEXT,
    gateway_payment_id TEXT,
    gateway_signature TEXT,

    confirmed_at TIMESTAMPTZ,
    preparing_at TIMESTAMPTZ,
    ready_at TIMESTAMPTZ,
    out_for_delivery_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,

    delivery_lat DOUBLE PRECISION,
    delivery_lng DOUBLE PRECISION,
    delivery_accuracy DOUBLE PRECISION,
    location_updated_at TIMESTAMPTZ
);


CREATE TABLE IF NOT EXISTS reservations (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    people INTEGER NOT NULL,
    at TEXT NOT NULL,
    message TEXT,
    created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS feedback (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT UNIQUE NOT NULL
        REFERENCES orders(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL,
    comment TEXT,
    created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS push_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS coupons (
    id BIGSERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    discount_type TEXT NOT NULL DEFAULT 'percent',
    discount_value NUMERIC(12,2) NOT NULL,
    min_order NUMERIC(12,2) DEFAULT 0,
    max_uses INTEGER DEFAULT 999999,
    used_count INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS coupons_code_lower_idx
ON coupons (LOWER(code));


CREATE TABLE IF NOT EXISTS order_status_history (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL
        REFERENCES orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    eta_minutes INTEGER,
    reason TEXT,
    created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS delivery_locations (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL
        REFERENCES orders(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    accuracy DOUBLE PRECISION,
    created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);


-- Cup & Slice menu seed data
INSERT INTO menu (name, category, price)
VALUES
    ('Margherita', 'pizza', 99),
    ('Cheese Corn', 'pizza', 159),
    ('Chicken Pizza', 'pizza', 209),
    ('Neapolitan', 'pizza', 249),
    ('Cappuccino', 'coffee', 199),
    ('Latte', 'coffee', 149),
    ('Mocha', 'coffee', 149),
    ('Today''s Soup', 'starter', 99),
    ('Garlic Bread', 'starter', 149),
    ('Nachos', 'starter', 109),
    ('Cheeseburger', 'burger', 399),
    ('Veggie Burger', 'burger', 179),
    ('Spicy Burger', 'burger', 299),
    ('Indian Twist', 'burger', 99),
    ('Fruity Mocktail', 'softdrinks', 199),
    ('Non-alcoholic Punch', 'softdrinks', 269),
    ('Faux Fizz', 'softdrinks', 299)
ON CONFLICT (name) DO NOTHING;