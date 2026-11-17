import { BaseError } from './BaseError';

/**
 * AuthorizationError - Thrown when user lacks permission
 *
 * Examples:
 * - Insufficient permissions
 * - Role-based access denial
 * - Resource ownership mismatch
 */
export class AuthorizationError extends BaseError {
  constructor(
    message: string,
    {
      userId,
      resource,
      action,
      correlationId
    }: {
      userId?: string;
      resource?: string;
      action?: string;
      correlationId?: string;
    } = {}
  ) {
    super(message, {
      code: 'AUTHORIZATION_ERROR',
      statusCode: 403,
      severity: 'warning',
      context: { userId, resource, action },
      correlationId
    });
  }
}
