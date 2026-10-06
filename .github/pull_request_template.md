## Summary

<!-- What does this PR change, and why? -->

## Related issue

<!-- e.g. Closes #12. Delete this section if there is none. -->

## Type of change

- [ ] Bug fix
- [ ] New feature or endpoint
- [ ] Breaking change to the API contract
- [ ] Refactor or cleanup
- [ ] Dependencies or tooling

## Endpoints affected

<!-- List each method and path, e.g. `PATCH /orders/:orderNumber/status`. Delete this section if there are none. -->

## How was this tested?

- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] Tried the change against a running server (`pnpm dev`)

## Checklist

- [ ] Admin routes still require a JWT Bearer token, and public checkout stays guest-only
- [ ] Prices, stock, subtotals, delivery fees and totals are computed on the server; clients send only product IDs and quantities
- [ ] Order status changes follow `NEXT_STATUSES`, and stock updates stay safe under concurrent requests
- [ ] `/orders/delivery-fee` is still registered before `/orders/:orderNumber`
- [ ] Responses use the `{ success, data, message }` envelope with validation at the boundary
- [ ] `API_ENDPOINTS.md` is updated, and coovi-admin and coovi-storefront are checked, if the contract changed
- [ ] Schema changes are compatible with existing MongoDB data, or a migration is described above
- [ ] No credentials, secrets or real environment values are committed
