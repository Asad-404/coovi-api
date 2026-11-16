import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Correlation ID middleware
 *
 * Adds a unique correlation ID to each request for tracing across services.
 * If the client provides X-Correlation-ID, it's preserved. Otherwise, we generate one.
 * The ID is returned in the response header for client-side tracking.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = (req.get('x-correlation-id') as string) || randomUUID();

  // Store correlation ID in request for later use
  (req as any).correlationId = correlationId;

  // Return correlation ID in response headers
  res.set('x-correlation-id', correlationId);

  next();
}
