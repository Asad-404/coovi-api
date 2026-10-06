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

Real values live only in `.env` (gitignored). Never commit credentials.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server with watch/restart |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run the compiled build (`node dist/index.js`) |
| `pnpm seed` | Replace DB contents with sample products (⚠️ deletes existing products) |

## API overview

- Public: product list/detail (search by name, sort by price, pagination with `limit` up to 50), order creation (COD, guest checkout; refused for products with `inStock: false` or too little `stock`), order lookup by order number + phone
- Admin (JWT `Authorization: Bearer <token>`): product create/update/delete (`PUT` is a full replace: optional fields left out are cleared), order list (`page`, `limit` up to 100, `status`), order status updates, editing an order's customer details (`PATCH /api/orders/:id` — name, phone, address, notes; not items or totals; refused once Delivered/Cancelled)

### Order status flow

Orders only move forward; any other change is a `409`:

```
Pending ──► Processing ──► Shipped ──► Delivered
   │            │
   └──► Cancelled ◄──┘
```

Stock is taken on Pending → Processing and returned on Processing → Cancelled. Each change is claimed atomically, so two admins clicking at once can't take or return stock twice.

Full endpoint contract: see `API_ENDPOINTS.md` in the project documentation.

## Project structure

```
src/
├── index.ts        # Entry point — starts server, seeds admin, graceful shutdown
├── config/         # MongoDB connection
├── models/         # Product, Order, Admin (Mongoose schemas)
├── routes/         # /api/products, /api/orders, /api/auth
├── middleware/     # requireAdmin (JWT verification)
└── seed.ts         # Sample product seeding (manual)
```
