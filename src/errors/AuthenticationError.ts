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
    context: Record<string, any> = {}
  ) {
    const { correlationId, ...restContext } = context;
    super(message, {
      code: 'AUTHENTICATION_ERROR',
      statusCode: 401,
      severity: 'warning',
      context: restContext,
      correlationId
    });
  }
}
