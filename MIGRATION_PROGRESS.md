# Structured Error Migration Progress

This document tracks the progress of migrating from manual error responses to structured error handling.

## Why This Migration?

The structured error system provides:
- ✅ Consistent error format across all endpoints
- ✅ Rich context data for debugging
- ✅ Correlation IDs for request tracing
- ✅ Severity levels for proper alerting
- ✅ Easy Sentry integration (future)
- ✅ Automatic sanitization of sensitive data

## Migration Status

### ✅ Completed
- [x] Error classes created (`src/errors/`)
- [x] Error handler middleware (`src/middleware/errorHandler.ts`)
- [x] Correlation ID middleware (`src/middleware/correlation.ts`)
- [x] Error utility helpers (`src/utils/errors.ts`)
- [x] Auth middleware (`src/middleware/auth.ts`)
- [x] Auth routes (`src/routes/auth.ts`)

### 🚧 In Progress
- [ ] Products routes (`src/routes/products.ts`)
- [ ] Orders routes (`src/routes/orders.ts`)
- [ ] Admins routes (`src/routes/admins.ts`)
- [ ] Customers routes (`src/routes/customers.ts`)
- [ ] Settings routes (`src/routes/settings.ts`)
- [ ] Stats routes (`src/routes/stats.ts`)
- [ ] Uploads routes (`src/routes/uploads.ts`)
- [ ] Courier payments routes (`src/routes/courierPayments.ts`)

### 📋 To Do
- [ ] Service files (steadfast, notify, etc.)
- [ ] Update tests to expect structured error responses
- [ ] Add integration tests for error scenarios

## Migration Pattern

### Before (Old Pattern)
```typescript
router.get('/:id', async (req, res) => {
  const item = await Model.findById(req.params.id);
  if (!item) {
    res.status(404).json({ 
      success: false, 
      message: 'Item not found' 
    });
    return;
  }
  res.json({ success: true, data: item });
});
```

### After (Structured Errors)
```typescript
import { throwNotFoundError } from '../utils/errors';

router.get('/:id', async (req, res, next) => {
  try {
    const item = await Model.findById(req.params.id);
    if (!item) {
      throwNotFoundError('Item not found', req, {
        resource: 'item',
        id: req.params.id
      });
    }
    res.json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
});
```

## Error Type Guidelines

| HTTP Status | Error Class | Use Case |
|-------------|-------------|----------|
| 400 | `ValidationError` | Invalid input, bad format, constraint violations |
| 401 | `AuthenticationError` | Missing/invalid token, expired session |
| 403 | `AuthorizationError` | Insufficient permissions |
| 404 | `NotFoundError` | Resource not found |
| 422 | `BusinessError` | Business logic violations (duplicate, stock issues) |
| 429 | `RateLimitError` | Rate limit exceeded |
| 500 | `DatabaseError` | Database operation failures |
| 502 | `ExternalServiceError` | Third-party API failures |

## Helper Functions

Located in `src/utils/errors.ts`:

- `throwValidationError(message, req, context?)` - For input validation failures
- `throwNotFoundError(message, req, context?)` - For resource not found
- `throwBusinessError(message, req, context?)` - For business logic violations
- `throwAuthenticationError(message, req, context?)` - For auth failures
- `throwAuthorizationError(message, req, context?)` - For permission denials
- `handleDuplicateKeyError(error, req, resource)` - For MongoDB duplicate keys

## Testing the Migration

1. **Check error responses**:
```bash
curl -i http://localhost:5000/api/products/invalid-id
# Should return structured error with correlationId
```

2. **Verify correlation IDs**:
```bash
curl -H "X-Correlation-ID: test-123" http://localhost:5000/api/products/999
# Response should include "correlationId": "test-123"
```

3. **Check logs**:
- Errors should be logged with full context
- Severity levels should be appropriate
- Sensitive data should be sanitized

## Next Steps

1. Continue migrating remaining route files
2. Update service layer to throw structured errors
3. Update tests to expect new error format
4. Add Sentry integration when ready
5. Set up error monitoring dashboards

## Notes

- Always add `next: NextFunction` parameter to route handlers
- Wrap route logic in try-catch and call `next(error)`
- Include correlation ID in all error contexts
- Use appropriate error types for different scenarios
- Add rich context data to help with debugging
