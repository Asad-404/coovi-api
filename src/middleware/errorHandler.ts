import { Request, Response, NextFunction } from 'express';

// Global error handler — every error a route doesn't handle itself ends up here.
// This ONE place decides what is the CLIENT's fault (400) vs the SERVER's (500).
// Express requires exactly 4 parameters for error middleware — that's how it knows.
export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Malformed JSON body — express.json() throws a SyntaxError with a `body` property.
  // Without this, Express's default handler returns an HTML error page.
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      success: false,
      message: 'Malformed JSON in request body'
    });
    return;
  }

  // Invalid ObjectId in a URL param (e.g. /api/products/xyz) — Mongoose CastError
  if (err.name === 'CastError') {
    res.status(400).json({
      success: false,
      message: `Invalid ${err.path}`
    });
    return;
  }

  // Mongoose schema validation (required / min / max) failed on save()
  if (err.name === 'ValidationError') {
    res.status(400).json({
      success: false,
      message: Object.values(err.errors)
        .map((e: any) => e.message)
        .join('; ')
    });
    return;
  }

  // MongoDB duplicate key (unique index, e.g. product slug)
  if (err.code === 11000) {
    res.status(400).json({
      success: false,
      message: 'A record with this value already exists'
    });
    return;
  }

  // Anything else is genuinely the server's fault
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
}
