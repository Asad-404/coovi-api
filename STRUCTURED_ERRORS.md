# Structured Error Handling

This document explains the structured error handling system implemented in the Coovi API.

## Overview

The structured error handling system provides:

- **Consistent error structure** across all services
- **Rich context data** for debugging and monitoring
- **Correlation IDs** for tracing requests across services
- **Severity levels** for proper error categorization
- **Security** through automatic sanitization of sensitive data
- **Easy integration** with monitoring tools like Sentry

## Error Types

### BaseError

The base class for all custom errors. Contains:

- `code`: Error code for categorization
- `statusCode`: HTTP status code
- `message`: Human-readable error message
- `context`: Additional data about the error
- `severity`: `critical`, `error`, `warning`, or `info`
- `timestamp`: When the error occurred
- `service`: Which service threw the error
- `correlationId`: Request tracking ID
- `isOperational`: Whether error is expected (true) or programmer error (false)

### Specific Error Types

1. **ValidationError** (400) - Input validation failures
   - Invalid format, missing fields, constraint violations
   
2. **AuthenticationError** (401) - Authentication failures
   - Invalid credentials, expired tokens, missing auth
   
3. **AuthorizationError** (403) - Permission denials
   - Insufficient permissions, role-based access denial
   
4. **NotFoundError** (404) - Resource not found
   - User not found, product not found, invalid ID
   
5. **BusinessError** (422) - Business logic violations
   - User already exists, insufficient stock, invalid state
   
6. **RateLimitError** (429) - Rate limit exceeded
   - Too many requests, throttling
   
7. **DatabaseError** (500) - Database operation failures
   - Connection failures, query errors, constraint violations
   
8. **ExternalServiceError** (502) - External API failures
   - Third-party API errors, network timeouts

## Usage Examples

### Basic Usage

```typescript
import { ValidationError, NotFoundError, BusinessError } from '../errors';

// Validation error
if (!email) {
  throw new ValidationError('Email is required', {
    field: 'email',
    constraint: 'required',
    correlationId: req.correlationId
  });
}

// Not found error
const user = await User.findById(id);
if (!user) {
  throw new NotFoundError('User not found', {
    resource: 'user',
    id,
    correlationId: req.correlationId
  });
}

// Business logic error
if (product.stock < quantity) {
  throw new BusinessError('Insufficient stock', {
    operation: 'createOrder',
    reason: 'insufficient_stock',
    available: product.stock,
    requested: quantity,
    correlationId: req.correlationId
  });
}
```

### In Route Handlers

```typescript
router.post('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validation
    if (!req.body.email) {
      throw new ValidationError('Email is required', {
        field: 'email',
        correlationId: (req as any).correlationId
      });
    }

    // Business logic
    const existingUser = await User.findOne({ email: req.body.email });
    if (existingUser) {
      throw new BusinessError('User already exists', {
        operation: 'createUser',
        reason: 'duplicate_email',
        correlationId: (req as any).correlationId
      });
    }

    const user = await User.create(req.body);
    res.status(201).json({ success: true, data: user });
  } catch (error) {
    next(error); // Pass to error handler
  }
});
```

### Database Operations

```typescript
try {
  const result = await db.collection.insertOne(data);
  return result;
} catch (error) {
  if (error.code === 11000) {
    throw new DatabaseError('Duplicate key violation', {
      table: 'users',
      operation: 'insert',
      originalError: error.message,
      correlationId
    });
  }
  
  throw new DatabaseError('Database operation failed', {
    table: 'users',
    operation: 'insert',
    originalError: error.message,
    isOperational: false, // Unexpected error
    correlationId
  });
}
```

### External API Calls

```typescript
try {
  const response = await axios.post(endpoint, data);
  return response.data;
} catch (error) {
  throw new ExternalServiceError('Payment gateway failed', {
    serviceName: 'PaymentGateway',
    endpoint,
    requestData: sanitizePaymentData(data),
    responseData: error.response?.data,
    statusCode: error.response?.status,
    correlationId
  });
}
```

## Error Response Format

All errors return a consistent JSON structure:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "correlationId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

In development mode, additional details are included:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "correlationId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "stack": "ValidationError: Email is required\n    at ...",
    "context": {
      "field": "email",
      "constraint": "required"
    }
  }
}
```

## Correlation IDs

Every request gets a unique correlation ID:

1. Client can provide `X-Correlation-ID` header
2. Server generates one if not provided
3. ID is returned in response header
4. ID is logged with all errors
5. Use it to trace requests across services

## Logging

Errors are logged with full context:

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

## Security

Sensitive data is automatically sanitized:

- Passwords
- Tokens
- API keys
- Credit card numbers
- CVV codes

## Migration Guide

### Before (Old Style)

```typescript
router.get('/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    return res.status(404).json({ 
      success: false, 
      message: 'User not found' 
    });
  }
  res.json({ success: true, data: user });
});
```

### After (New Structured Style)

```typescript
import { NotFoundError } from '../errors';

router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      throw new NotFoundError('User not found', {
        resource: 'user',
        id: req.params.id,
        correlationId: (req as any).correlationId
      });
    }
    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
});
```

## Future: Sentry Integration

When ready to add Sentry, the system is already structured for easy integration:

```typescript
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  beforeSend(event, hint) {
    const error = hint.originalException;
    if (error instanceof BaseError) {
      event.tags = {
        error_code: error.code,
        severity: error.severity,
        service: error.service
      };
      event.contexts.custom_context = error.context;
    }
    return event;
  }
});
```

## Benefits

✅ Easy to identify error source (service, code, stack trace)  
✅ Rich context for debugging (request data, user info, operation details)  
✅ Correlation IDs for tracing across services  
✅ Severity levels for proper alerting  
✅ Automatic sanitization of sensitive data  
✅ Consistent error responses  
✅ Ready for monitoring tools like Sentry
