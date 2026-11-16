import { BaseError } from './BaseError';

/**
 * ExternalServiceError - Thrown when external API calls fail
 *
 * Examples:
 * - Third-party API errors
 * - Network timeouts
 * - Invalid API responses
 * - Service unavailable
 */
export class ExternalServiceError extends BaseError {
  constructor(
    message: string,
    {
      serviceName,
      endpoint,
      requestData,
      responseData,
      statusCode,
      correlationId
    }: {
      serviceName?: string;
      endpoint?: string;
      requestData?: any;
      responseData?: any;
      statusCode?: number;
      correlationId?: string;
    } = {}
  ) {
    super(message, {
      code: 'EXTERNAL_SERVICE_ERROR',
      statusCode: 502,
      severity: 'error',
      context: { serviceName, endpoint, requestData, responseData, externalStatusCode: statusCode },
      correlationId
    });
  }
}
