# Error Handling Integration Guide

This guide explains how the structured error handling system is integrated throughout the COOVI API service.

## Overview

The COOVI API now uses a comprehensive structured error handling system that provides:

✅ **Consistent error responses** across all endpoints  
✅ **Rich debugging context** with correlation IDs  
✅ **Automatic security** through sensitive data sanitization  
✅ **Ready for Sentry** - structured for easy monitoring integration  
✅ **Type-safe errors** with proper HTTP status codes  
✅ **Centralized logging** with severity levels

## Architecture

```
Request → Correlation Middleware → Routes → Error Handler → Response
                ↓                      ↓           ↓
           Adds correlationId    Throws structured    Logs & formats
                                      errors            response
```

### Core Components

1. **Error Classes** (`src/errors/`)
   - `BaseError` - Foundation for all custom errors
   - `ValidationError` (400) - Input validation failures
   - `AuthenticationError` (401) - Auth failures
   - `AuthorizationError` (403) - Permission denials
   - `NotFoundError` (404) - Resource not found
   - `BusinessError` (422) - Business logic violations
   - `RateLimitError` (429) - Rate limit exceeded
   - `DatabaseError` (500) - Database failures
   - `ExternalServiceError` (502) - Third-party API failures

2. **Error Handler Middleware** (`src/middleware/errorHandler.ts`)
   - Catches all errors from routes
   - Formats consistent JSON responses
   - Logs with appropriate severity
   - Sanitizes sensitive data
   - Adds correlation IDs

3. **Correlation Middleware** (`src/middleware/correlation.ts`)
   - Generates/receives correlation IDs
   - Attaches to request object
   - Returns in response headers
   - Enables request tracing

4. **Error Utilities** (`src/utils/errors.ts`)
   - Helper functions for throwing errors
   - Automatic correlation ID injection
   - Simplified error creation

## Usage in Routes

### Basic Pattern

```typescript
import { NextFunction, Request, Response } from 'express';
import { throwNotFoundError, throwValidationError } from '../utils/errors';

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validate input
    if (!isValidId(req.params.id)) {
      throwValidationError('Invalid ID format', req, {
        field: 'id',
        value: req.params.id
      });
    }

    // Fetch resource
    const item = await Model.findById(req.params.id);
    
    if (!item) {
      throwNotFoundError('Item not found', req, {
        resource: 'item',
        id: req.params.id
      });
    }

    // Success response
    res.json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
});
```

### Error Type Selection

Choose the appropriate error type based on the scenario:

```typescript
// ❌ Input validation failed
throwValidationError('Email is required', req, {
  field: 'email',
  constraint: 'required'
});

// ❌ Not authenticated
throwAuthenticationError('Invalid token', req, {
  reason: 'token_expired'
});

// ❌ Not authorized
throwAuthorizationError('Insufficient permissions', req, {
  resource: 'products',
  action: 'delete',
  required: 'products.delete'
});

// ❌ Resource not found
throwNotFoundError('Product not found', req, {
  resource: 'product',
  id: req.params.id
});

// ❌ Business logic violation
throwBusinessError('Insufficient stock', req, {
  operation: 'createOrder',
  available: 5,
  requested: 10
});
```

### Database Error Handling

```typescript
try {
  await Product.create(data);
} catch (error: any) {
  if (error.code === 11000) {
    // Duplicate key error
    handleDuplicateKeyError(error, req, 'product');
  }
  throw error; // Let error handler deal with other errors
}
```

## Error Response Format

### Production Response
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Product not found",
    "correlationId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

### Development Response (includes debug info)
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Product not found",
    "correlationId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "stack": "NotFoundError: Product not found\n    at ...",
    "context": {
      "resource": "product",
      "id": "123456"
    }
  }
}
```

## Correlation IDs

Every request gets a unique correlation ID for tracing:

### Client Provides ID
```bash
curl -H "X-Correlation-ID: my-trace-id" https://api.example.com/products/123
```

### Server Generates ID
If no header is provided, the server generates a UUID.

### Returned in Response
```
X-Correlation-ID: 550e8400-e29b-41d4-a716-446655440000
```

### Logged with Errors
All errors are logged with their correlation ID for debugging.

## Logging

Errors are logged with structured data:

```json
{
  "error": {
    "name": "ValidationError",
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "severity": "warning",
    "context": {
      "field": "email",
      "constraint": "required"
    },
    "correlationId": "550e8400-e29b-41d4-a716-446655440000"
  },
  "request": {
    "method": "POST",
    "url": "/api/users",
    "body": { "name": "John" },
    "ip": "192.168.1.1"
  },
  "user": {
    "id": "admin123",
    "email": "admin@example.com",
    "role": "owner"
  }
}
```

### Severity Levels

- **critical** - System failures, data corruption
- **error** - Application errors, unexpected exceptions
- **warning** - Validation failures, business rule violations
- **info** - Expected errors, rate limits

## Security

Sensitive data is automatically sanitized in logs and error responses:

- Passwords
- Tokens
- API keys
- Credit card numbers
- CVV codes
- Authorization headers

## Migration Status

### ✅ Completed
- Error classes and infrastructure
- Auth routes and middleware
- Error utilities

### 🚧 In Progress
- Product routes
- Order routes
- Other route files

Check migration progress:
```bash
npm run check-migration
```

See `MIGRATION_PROGRESS.md` for detailed status.

## Future: Sentry Integration

The system is designed for easy Sentry integration:

```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  beforeSend(event, hint) {
    const error = hint.originalException;
    
    // Structured errors include rich context
    if (error instanceof BaseError) {
      event.tags = {
        error_code: error.code,
        severity: error.severity,
        service: error.service
      };
      event.contexts.custom_context = error.context;
      event.fingerprint = [error.code, error.message];
    }
    
    return event;
  }
});
```

## Testing

### Test Error Responses
```bash
# Test 404
curl -i http://localhost:5000/api/products/invalid-id

# Test with correlation ID
curl -H "X-Correlation-ID: test-123" \
  http://localhost:5000/api/products/999

# Test validation error
curl -X POST http://localhost:5000/api/products \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Verify Logging
Check server logs for structured error output with:
- Correlation IDs
- Full request context
- Sanitized sensitive data
- Appropriate severity levels

## Best Practices

1. **Always use structured errors** - Never return manual error responses
2. **Include rich context** - Add relevant data to help debugging
3. **Use appropriate error types** - Match the error to the scenario
4. **Add correlation IDs** - Use helper functions to auto-inject
5. **Wrap in try-catch** - Always call `next(error)` in catch blocks
6. **Don't expose internals** - Keep error messages user-friendly
7. **Log at correct severity** - Use error types that match severity

## Support

For questions or issues with the error handling system:
- Check `STRUCTURED_ERRORS.md` for detailed documentation
- Check `MIGRATION_PROGRESS.md` for migration status
- Run `npm run check-migration` to find remaining work
- See `src/examples/errorUsageExamples.ts` for more examples
