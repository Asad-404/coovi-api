import { BaseError } from './BaseError';

/**
 * NotFoundError - Thrown when a resource is not found
 *
 * Examples:
 * - User not found
 * - Product not found
 * - Order not found
 * - Invalid ID
 */
export class NotFoundError extends BaseError {
  constructor(
    message: string,
    {
      resource,
      id,
      correlationId
    }: {
      resource?: string;
      id?: string;
      correlationId?: string;
    } = {}
  ) {
    super(message, {
      code: 'NOT_FOUND',
      statusCode: 404,
      severity: 'info',
      context: { resource, id },
      correlationId
    });
  }
}
