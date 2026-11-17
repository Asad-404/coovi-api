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
    {
      query,
      params,
      table,
      operation,
      originalError,
      correlationId
    }: {
      query?: string;
      params?: any;
      table?: string;
      operation?: string;
      originalError?: string;
      correlationId?: string;
    } = {}
  ) {
    super(message, {
      code: 'DATABASE_ERROR',
      statusCode: 500,
      severity: 'critical',
      context: { query, params, table, operation, originalError },
      correlationId
    });
  }
}
