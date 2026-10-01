# Cup & Slice — Real Restaurant Ordering Platform

Cup & Slice is a full-stack restaurant ordering project with a separate customer website, secure owner/admin login, SQLite database, real payment gateway integration points, kitchen workflow, customer notifications, ETA countdown and delivery GPS tracking.

## Main features

### Customer
- Signup/login/profile
- Menu search/filter and ordering
- Delivery, pickup and dine-in
- Address, table number, notes and allergy/special instructions
- Tax and tip
- Cash, Pay at Cafe, UPI/Google Pay, PhonePe, Paytm and Razorpay checkout
- Payment verification / failed payment handling
- Order history and cancellation where allowed
- Live status + ETA countdown
- Live delivery coordinates while an order is out for delivery
- Notifications + browser Push permission
- Ratings and feedback
- PWA **Download App**

### Owner/Admin
- Separate direct login at `/admin.html`
- No Admin Panel link on the customer website
- New-order dashboard
- Confirm order + choose ETA
- Cancel order + customer-facing cancellation reason
- Preparing / Ready / Out for Delivery / Delivered
- Update ETA later
- Payment verification/refund status workflow
- Customer broadcast notifications and default templates
- Customer/user/staff account management
- Kitchen Display and Delivery Console links
- Menu management API and coupon API
- Revenue, order, customer, review and active-delivery statistics

### Kitchen
`/kitchen.html` provides a staff login and live preparation queue.

### Delivery
`/delivery.html` provides a delivery-staff login. For an active `out_for_delivery` order, the delivery staff member can allow browser GPS and send location updates to the backend. Customers can see the latest location and ETA in their dashboard.

## Database

SQLite is used. The database is automatically created at:

```text
data/cafe.db
```

Main tables:

```text
users
menu
orders
reservations
notifications
feedback
push_subscriptions
coupons
order_status_history
delivery_locations
```

The ZIP does **not** contain a test database. It is created on first run.

## Run locally

Requirements: Node.js 22.13+

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

### First-time owner setup

```text
http://localhost:3000/setup.html
```

Create your own Owner/Admin ID and password. There is no hard-coded admin password.

### Admin

```text
http://localhost:3000/admin.html
```

### Kitchen

```text
http://localhost:3000/kitchen.html
```

### Delivery GPS

```text
http://localhost:3000/delivery.html
```

### Backend health

```text
http://localhost:3000/api/health
```

Expected response contains:

```json
{"status":"ok","backend":true,"database":true}
```

## Real payment setup

The project never fakes a successful online payment.

### Cash / Pay at Cafe
Works without a payment gateway.

### UPI / PhonePe / Paytm
Configure the restaurant's own UPI/payment details in `.env` and use the UTR/reference workflow.

### Razorpay
For actual online collection, add the restaurant owner's Razorpay merchant credentials to `.env`:

```text
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=your_razorpay_secret
```

Use test keys first. Live collection requires the merchant account to be activated by the payment provider.

**Never put `RAZORPAY_KEY_SECRET` in frontend code or GitHub.**

## Browser notifications

Customers can allow browser notifications from the dashboard. Push subscriptions are stored in SQLite. Production browser Push requires HTTPS.

## Live delivery location

The delivery staff member must:
1. Log in at `/delivery.html`.
2. Have an active order assigned/in `out_for_delivery` status.
3. Click Start/Update GPS.
4. Allow browser location permission.

The browser sends latitude/longitude to the backend. The customer dashboard polls the backend and shows the latest coordinates and ETA. Location sharing is accepted only for an active `out_for_delivery` order.

## PWA / Download App

The project includes:

- `manifest.json`
- Service worker
- App icon
- Install prompt
- Responsive pages

A browser can install the website as an app when PWA requirements are met. A native Android APK/AAB is a separate packaging step.

## Local network / IP

Run:

```bat
ipconfig
```

Find the computer's IPv4 Address and open from a phone on the same Wi-Fi:

```text
http://YOUR-IP:3000
```

Example only:

```text
http://192.168.1.10:3000
```

The actual IP depends on the computer/network and is not guessed or hard-coded.

## Production deployment

Set environment variables from `.env.example`, use `npm start`, and configure persistent storage for SQLite. For a multi-instance production deployment, use a managed database instead of local SQLite or provide persistent storage.

## Project structure

```text
Cup-and-Slice-FULLSTACK-PRO-v4/
├── frontend/
│   ├── index.html
│   ├── dashboard.html
│   ├── admin.html
│   ├── kitchen.html
│   ├── delivery.html
│   ├── setup.html
│   ├── script.js
│   ├── style1.css
│   ├── manifest.json
│   └── sw.js
├── backend/
│   ├── server.js
│   └── api.test.js
├── data/
│   └── cafe.db          # created automatically on first run
├── .env.example
├── .gitignore
├── START-HERE.txt
├── README.md
└── package.json
```

## Testing

```bash
npm test
```

The included API test suite covers menu seeding, registration/order creation, invalid input/login and reservations.
