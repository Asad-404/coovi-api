# COOVI API

REST API for the COOVI saree e-commerce platform (Bangladesh market).

**Stack:** Express 5 · TypeScript · MongoDB (Mongoose) · JWT admin auth

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in the values (see below)
pnpm dev               # http://localhost:5000
```

Requires Node 24+, pnpm, and a MongoDB Atlas cluster (network access `0.0.0.0/0` for dynamic-IP hosts).

## Environment variables

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Atlas connection string (required) |
| `PORT` | Server port — platform-provided in production (default 5000) |
| `NODE_ENV` | `production` hides error details in responses |
| `JWT_SECRET` | Signs admin tokens (required — server exits without it) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | First-boot admin seed (only when no admin exists) |
| `CORS_ORIGINS` | Browser origins allowed to call the API |
| `DELIVERY_FEE_INSIDE_DHAKA` / `DELIVERY_FEE_OUTSIDE_DHAKA` | Delivery fees in BDT (blank = 70 and 130) |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Admin photo upload (blank = switched off) |
| `STEADFAST_API_KEY` / `STEADFAST_SECRET_KEY` / `STEADFAST_BASE_URL` | "Book with Steadfast" (blank keys = switched off; the base URL is optional) |
| `STOREFRONT_API_KEY` | Shared secret that gives the storefront server its own rate limit; same value on the storefront |
| `TRUST_PROXY` | Reverse-proxy hops to trust (default 1 in production, 0 elsewhere) |
| `EMAIL_API_KEY` / `NOTIFY_EMAIL_TO` / `NOTIFY_EMAIL_FROM` / `ADMIN_URL` | New-order email alerts through Resend (blank key = no alerts; the sender and admin link are optional) |

Real values live only in `.env` (gitignored). Never commit credentials.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server with watch/restart |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run the compiled build (`node dist/index.js`) |
| `pnpm test` | Run the tests |
| `pnpm seed` | Replace DB contents with sample products (⚠️ deletes existing products; refused in production, and needs `--confirm=<database name>` on a database that has products) |

## API overview

- Public: product list/detail (search by name, sort by price, pagination with `limit` up to 50), order creation (COD, guest checkout; refused for products with `inStock: false` or too little `stock`), order lookup by order number + phone
- Public also: delivery fees, shop settings
- Admin (JWT `Authorization: Bearer <token>`, with per-person permissions): product create/update/delete (`PUT` is a full replace: optional fields left out are cleared) with drafts and publishing, photo upload signatures, order list with search and filters (`limit` up to 100), manual orders, order status updates, editing an order's customer details (`PATCH /api/orders/:id` — not items; refused once Delivered/Cancelled/Returned), notes, Steadfast booking, courier payments, customers and block list, statistics, shop settings, team accounts

### Order status flow

Orders only move forward; any other change is a `409`:

```
Pending ──► Processing ──► Shipped ──► Delivered
   │            │             │
   └──► Cancelled ◄──┘        └──► Returned
```

`Returned` is a parcel refused at the door; the shop takes no returns after delivery. Stock is taken on Pending → Processing and returned on Processing → Cancelled and Shipped → Returned (unless `restock` is false). Pre-order lines never take or return stock. Each change is claimed atomically, so two admins clicking at once can't take or return stock twice.

Full endpoint contract: see `API_ENDPOINTS.md` in the project documentation.

## Project structure

```
src/
├── index.ts        # Entry point — starts server, seeds admin, graceful shutdown
├── config/         # MongoDB connection
├── models/         # Product, Order, Admin, BlockedPhone, CourierPayment, Settings (Mongoose schemas)
├── routes/         # products, orders, auth, uploads, courier-payments, settings, admins, stats, customers
├── services/       # Order pricing, delivery fees, settings, email alerts, Steadfast, product photos
├── middleware/     # Admin auth and permissions, rate limits, error handler
├── permissions.ts  # Team permissions and role presets
└── seed.ts         # Sample product seeding (manual)
```
