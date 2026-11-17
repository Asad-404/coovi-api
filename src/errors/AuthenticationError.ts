import { BaseError } from './BaseError';

/**
 * AuthenticationError - Thrown when authentication fails
 *
 * Examples:
 * - Invalid credentials
 * - Expired token
 * - Missing token
 * - Invalid token format
 */
export class AuthenticationError extends BaseError {
  constructor(
    message: string,
    {
      userId,
      attemptedAction,
      correlationId
    }: {
      userId?: string;
      attemptedAction?: string;
      correlationId?: string;
    } = {}
  ) {
    super(message, {
      code: 'AUTHENTICATION_ERROR',
      statusCode: 401,
      severity: 'warning',
      context: { userId, attemptedAction },
      correlationId
    });
  }
}
