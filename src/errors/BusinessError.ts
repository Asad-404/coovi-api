import { BaseError } from './BaseError';

/**
 * BusinessError - Thrown when business logic rules are violated
 *
 * Examples:
 * - User already exists
 * - Insufficient stock
 * - Order cannot be cancelled (already shipped)
 * - Invalid state transition
 */
export class BusinessError extends BaseError {
  constructor(
    message: string,
    {
      operation,
      reason,
      correlationId,
      ...contextData
    }: {
      operation?: string;
      reason?: string;
      correlationId?: string;
      [key: string]: any;
    } = {}
  ) {
    super(message, {
      code: 'BUSINESS_ERROR',
      statusCode: 422,
      severity: 'error',
      context: { operation, reason, ...contextData },
      correlationId
    });
  }
}
