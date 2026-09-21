# CLAUDE.md
This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Commands

Use pnpm 10.28.2 and run commands from this repository:

```bash
pnpm install
pnpm dev
pnpm build
pnpm start
pnpm test
pnpm exec vitest run <test-file>
```

`pnpm seed` replaces database product data with sample products; use it only when explicitly intended.

## Architecture

- `src/index.ts` starts Express, connects to MongoDB, seeds the first admin, registers middleware/routes, and handles shutdown.
- `src/config/` owns the MongoDB connection; `src/models/` owns Mongoose schemas; `src/routes/` owns products, orders, and auth endpoints; `src/middleware/` owns JWT admin authorization.
- Protected admin routes require a JWT Bearer token. Public checkout is guest-only.
- The server loads product prices and stock from MongoDB and computes order items, subtotal, delivery fee, and total. Clients should send only product IDs and quantities.
- Stock changes on status transitions: `Pending → Processing` decrements stock, and `Processing → Cancelled` restores it.
- Register `/orders/delivery-fee` before `/orders/:orderNumber`; route ordering is significant.
- API responses use the `{ success, data, message }` envelope where applicable, with validation and error handling at the API boundary.

The cross-project contract is `..\API_ENDPOINTS.md`; trust the route implementation if a stale document disagrees with code, then update the contract when the behavior is intentionally changed.
