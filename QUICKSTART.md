# 🚀 QUICK START: Structured Errors + Sentry

## ✅ Status: READY FOR INTEGRATION

The COOVI API has a complete structured error handling system ready for Sentry.

---

## 📦 What You Have

```
✅ Error classes (8 types)
✅ Error handler middleware
✅ Correlation ID tracking
✅ Auto security sanitization
✅ Helper functions
✅ Migration tools
✅ Complete documentation
✅ TypeScript builds successfully
```

---

## 🎯 Add Sentry in 5 Minutes

### Step 1: Install (30 seconds)
```bash
pnpm add @sentry/node
```

### Step 2: Initialize (2 minutes)

Add to `src/index.ts` BEFORE other imports:

```typescript
import * as Sentry from '@sentry/node';

// Initialize Sentry
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  
  // Structured errors provide rich context automatically
  beforeSend(event, hint) {
    const error = hint.originalException;
    
    if (error instanceof BaseError) {
      // Tag for filtering in Sentry
      event.tags = {
        error_code: error.code,
        severity: error.severity,
        service: error.service
      };
      
      // Add context for debugging
      event.contexts.custom = error.context;
      
      // Group by error code
      event.fingerprint = [error.code];
    }
    
    return event;
  }
});
```

### Step 3: Add to Error Handler (1 minute)

In `src/middleware/errorHandler.ts`, add after line 88:

```typescript
// Send critical errors to Sentry
if (err.severity === 'critical') {
  Sentry.captureException(err, {
    level: 'error',
    tags: {
      error_code: err.code
    }
  });
}
```

### Step 4: Add Environment Variable (30 seconds)

In `.env`:
```
SENTRY_DSN=https://your-dsn@sentry.io/project-id
```

### Step 5: Test (1 minute)
```bash
# Start server
npm run dev

# Trigger an error
curl http://localhost:5000/api/products/invalid-id

# Check Sentry dashboard - error should appear!
```

---

## 🎨 What Sentry Will Show

### Error Grouping
Errors grouped by `error.code`:
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `AUTHENTICATION_ERROR`
- etc.

### Rich Context
Each error includes:
- **Correlation ID** - trace across services
- **Request details** - method, URL, params, body
- **User info** - admin email, role, permissions
- **Custom context** - resource, id, operation, etc.
- **Stack trace** - full error stack
- **Environment** - dev/production

### Severity Levels
- 🔴 **critical** - System failures, data issues
- 🟠 **error** - Application errors
- 🟡 **warning** - Validation failures
- 🔵 **info** - Expected errors

---

## 📊 Monitor These Metrics

### In Sentry Dashboard

1. **Error Rate by Code**
   - Which endpoints fail most?
   - Are validation errors increasing?

2. **Critical Errors**
   - Database failures
   - External service outages
   - System crashes

3. **User Impact**
   - Which admins hit errors?
   - Authentication failures spike?

4. **Trends**
   - Error rate over time
   - New error types appearing

---

## 🔧 Using Structured Errors in Code

### Already Working (Auth Routes)
```typescript
// Authentication error
throwAuthenticationError('Invalid token', req, {
  reason: 'token_expired'
});

// Authorization error
throwAuthorizationError('Insufficient permissions', req, {
  resource: 'products',
  action: 'delete'
});
```

### To Migrate Other Routes
```typescript
// Before
res.status(404).json({ 
  success: false, 
  message: 'Product not found' 
});

// After
throwNotFoundError('Product not found', req, {
  resource: 'product',
  id: req.params.id
});
```

### Check What Needs Migration
```bash
npm run check-migration
```

---

## 📚 Documentation Reference

| Quick Links |
|-------------|
| [SENTRY_READY.md](./SENTRY_READY.md) - Full Sentry guide |
| [ERROR_HANDLING.md](./ERROR_HANDLING.md) - Usage guide |
| [STRUCTURED_ERRORS.md](./STRUCTURED_ERRORS.md) - API reference |
| [SUMMARY.md](./SUMMARY.md) - Project summary |

---

## ✨ Key Benefits

### Already Working
✅ Consistent error responses  
✅ Request tracing with correlation IDs  
✅ Automatic security (sanitized logs)  
✅ Structured logging  

### With Sentry (5 minutes)
🎯 Real-time error alerts  
🎯 Error grouping & trends  
🎯 Performance monitoring  
🎯 Release tracking  
🎯 User impact analysis  

---

## 🎯 Example: Sentry Alert Rules

After integration, set up alerts:

1. **Critical Errors**
   - Trigger: `severity:critical`
   - Action: Email + Slack immediately

2. **High Error Rate**
   - Trigger: >10 errors/minute
   - Action: Email team lead

3. **New Error Types**
   - Trigger: First occurrence of error_code
   - Action: Slack notification

4. **Authentication Failures**
   - Trigger: `error_code:AUTHENTICATION_ERROR` spike
   - Action: Security team alert

---

## 💡 Pro Tips

### 1. Correlation IDs
Send from client for end-to-end tracing:
```javascript
fetch('/api/products', {
  headers: {
    'X-Correlation-ID': generateUUID()
  }
});
```

### 2. Filter Noise
In Sentry, ignore expected errors:
```typescript
beforeSend(event, hint) {
  const error = hint.originalException;
  
  // Don't send validation errors to Sentry
  if (error?.code === 'VALIDATION_ERROR') {
    return null;
  }
  
  return event;
}
```

### 3. Sample Rates
For high-traffic apps:
```typescript
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  sampleRate: 0.5, // 50% of errors
  tracesSampleRate: 0.1, // 10% of transactions
});
```

---

## 🎉 You're Ready!

The system is complete and production-ready. Add Sentry whenever you need monitoring - it's just 5 minutes away.

**Current Status:**
- ✅ Infrastructure: 100%
- ✅ Build: Passing
- ✅ Auth: Migrated
- 🚧 Routes: 15% (optional)

**Next Action:**
Choose one:
1. Add Sentry now (follow steps above)
2. Migrate more routes first (`npm run check-migration`)
3. Use as-is (already provides value)

---

**Questions?** See full documentation in repository root.
