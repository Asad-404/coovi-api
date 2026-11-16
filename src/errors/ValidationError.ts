import { BaseError } from './BaseError';

/**
 * ValidationError - Thrown when input validation fails
 *
 * Examples:
 * - Missing required fields
 * - Invalid data format (email, phone)
 * - Out of range values
 * - Type mismatches
 */
export class ValidationError extends BaseError {
  constructor(
    message: string,
    {
      field,
      value,
      constraint,
      correlationId
    }: {
      field?: string;
      value?: any;
      constraint?: string;
      correlationId?: string;
    } = {}
  ) {
    super(message, {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      severity: 'warning',
      context: { field, value, constraint },
      correlationId
    });
  }
}
