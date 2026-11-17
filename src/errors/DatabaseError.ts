import { BaseError } from './BaseError';

/**
 * DatabaseError - Thrown when database operations fail
 *
 * Examples:
 * - Connection failures
 * - Query timeouts
 * - Constraint violations
 * - Transaction rollbacks
 */
export class DatabaseError extends BaseError {
  constructor(
    message: string,
    context: Record<string, any> = {}
  ) {
    const { correlationId, ...restContext } = context;
    super(message, {
      code: 'DATABASE_ERROR',
      statusCode: 500,
      severity: 'critical',
      context: restContext,
      correlationId
    });
  }
}
