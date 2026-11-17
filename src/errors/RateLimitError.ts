import { BaseError } from './BaseError';

/**
 * RateLimitError - Thrown when rate limit is exceeded
 *
 * Examples:
 * - Too many login attempts
 * - API rate limit exceeded
 * - Request throttling
 */
export class RateLimitError extends BaseError {
  constructor(
    message: string,
    {
      limit,
      window,
      identifier,
      correlationId
    }: {
      limit?: number;
      window?: string;
      identifier?: string;
      correlationId?: string;
    } = {}
  ) {
    super(message, {
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
      severity: 'warning',
      context: { limit, window, identifier },
      correlationId
    });
  }
}
