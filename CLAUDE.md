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

Claude may run `pnpm test`, `pnpm build` and `pnpm exec tsc --noEmit` to check changes, and may push feature branches and open pull requests; never push `master`. Do not start `pnpm dev` or run `pnpm seed` unless asked.

GitHub Actions (`.github/workflows/ci.yml`) runs the typecheck and the tests on every pull request and push to `master`. Keep it green.

## Architecture

- `src/app.ts` builds the Express app (middleware, routes, error handler); `src/index.ts` connects to MongoDB, seeds the first admin, starts the server, and handles shutdown.
- `src/config/` owns the MongoDB connection; `src/models/` owns Mongoose schemas; `src/routes/` owns products, orders, and auth endpoints; `src/middleware/` owns JWT admin authorization.
- Protected admin routes require a JWT Bearer token. Public checkout is guest-only.
- The server loads product prices and stock from MongoDB and computes order items, subtotal, delivery fee, and total. Clients should send only product IDs and quantities.
- Order status is forward-only (`NEXT_STATUSES` in `src/routes/orders.ts`): Pending → Processing | Cancelled, Processing → Shipped | Cancelled, Shipped → Delivered; Delivered and Cancelled are final. Other transitions return 409.
- Stock changes on status transitions: `Pending → Processing` decrements stock, and `Processing → Cancelled` restores it. The transition is claimed with a conditional update on the old status so concurrent requests can't double-apply stock.
- Tests use mongodb-memory-server; where its binary download is blocked, point `MONGOMS_SYSTEM_BINARY` at a local `mongod`.
- Register `/orders/delivery-fee` before `/orders/:orderNumber`; route ordering is significant.
- API responses use the `{ success, data, message }` envelope where applicable, with validation and error handling at the API boundary.

The cross-project contract is `..\API_ENDPOINTS.md`; trust the route implementation if a stale document disagrees with code, then update the contract when the behavior is intentionally changed.
