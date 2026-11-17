import { Request, Response, NextFunction } from 'express';
import { BaseError } from '../errors';

/**
 * Sanitize sensitive data from request body
 */
function sanitizeBody(body: any): any {
  if (!body || typeof body !== 'object') return body;

  const sensitive = ['password', 'token', 'apiKey', 'secret', 'creditCard', 'cvv', 'passwordHash'];
  const sanitized = { ...body };

  sensitive.forEach((key) => {
    if (sanitized[key]) sanitized[key] = '[REDACTED]';
  });

  return sanitized;
}

/**
 * Sanitize sensitive data from request headers
 */
function sanitizeHeaders(headers: any): any {
  if (!headers || typeof headers !== 'object') return headers;

  const sensitive = ['authorization', 'cookie', 'x-api-key'];
  const sanitized = { ...headers };

  sensitive.forEach((key) => {
    if (sanitized[key]) sanitized[key] = '[REDACTED]';
  });

  return sanitized;
}

/**
 * Global error handler — every error a route doesn't handle itself ends up here.
 * This ONE place decides what is the CLIENT's fault (400) vs the SERVER's (500).
 * Express requires exactly 4 parameters for error middleware — that's how it knows.
 */
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  // Get correlation ID from request
  const correlationId = (req as any).correlationId;

  // Set correlation ID on error if not already set
  if (err.correlationId === undefined) {
    err.correlationId = correlationId;
  }

  // Build request context for logging
  const requestContext = {
    method: req.method,
    url: req.url,
    params: req.params,
    query: req.query,
    body: sanitizeBody(req.body),
    headers: sanitizeHeaders(req.headers),
    ip: req.ip,
    userAgent: req.get('user-agent'),
    correlationId
  };

  // Build user context for logging
  const userContext = (req as any).admin
    ? {
        id: (req as any).admin.id,
        email: (req as any).admin.email,
        role: (req as any).admin.role
      }
    : null;

  // Handle custom structured errors
  if (err instanceof BaseError) {
    const errorLog = {
      error: err.toJSON(),
      request: requestContext,
      user: userContext
    };

    // Log based on severity
    if (err.severity === 'critical') {
      console.error('[CRITICAL]', JSON.stringify(errorLog, null, 2));
    } else if (err.severity === 'error') {
      console.error('[ERROR]', JSON.stringify(errorLog, null, 2));
    } else if (err.severity === 'warning') {
      console.warn('[WARNING]', JSON.stringify(errorLog, null, 2));
    } else {
      console.info('[INFO]', JSON.stringify(errorLog, null, 2));
    }

    // Send response to client
    const response: any = {
      success: false,
      error: {
        code: err.code,
        message: err.isOperational ? err.message : 'An unexpected error occurred',
        correlationId,
        timestamp: err.timestamp
      }
    };

    // Include additional details in development
    if (process.env.NODE_ENV === 'development') {
      response.error.stack = err.stack;
      response.error.context = err.context;
    }

    res.status(err.statusCode).json(response);
    return;
  }

  // Handle legacy/system errors

  // Malformed JSON body — express.json() throws a SyntaxError with a `body` property
  if (err instanceof SyntaxError && 'body' in err) {
    console.warn('[WARNING]', JSON.stringify({ error: 'Malformed JSON', request: requestContext }, null, 2));
    res.status(400).json({
      success: false,
      error: {
        code: 'MALFORMED_JSON',
        message: 'Malformed JSON in request body',
        correlationId
      }
    });
    return;
  }

  // Invalid ObjectId in a URL param (e.g. /api/products/xyz) — Mongoose CastError
  if (err.name === 'CastError') {
    console.warn('[WARNING]', JSON.stringify({ error: 'Invalid ID format', request: requestContext }, null, 2));
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_ID',
        message: `Invalid ${err.path}`,
        correlationId
      }
    });
    return;
  }

  // Mongoose schema validation (required / min / max) failed on save()
  if (err.name === 'ValidationError') {
    console.warn('[WARNING]', JSON.stringify({ error: 'Validation failed', request: requestContext }, null, 2));
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: Object.values(err.errors)
          .map((e: any) => e.message)
          .join('; '),
        correlationId
      }
    });
    return;
  }

  // MongoDB duplicate key (unique index, e.g. product slug)
  if (err.code === 11000) {
    console.warn('[WARNING]', JSON.stringify({ error: 'Duplicate key', request: requestContext }, null, 2));
    res.status(400).json({
      success: false,
      error: {
        code: 'DUPLICATE_KEY',
        message: 'A record with this value already exists',
        correlationId
      }
    });
    return;
  }

  // Anything else is genuinely the server's fault
  console.error(
    '[CRITICAL]',
    JSON.stringify(
      {
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack
        },
        request: requestContext,
        user: userContext
      },
      null,
      2
    )
  );

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      correlationId,
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    }
  });
}
