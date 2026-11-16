/**
 * Base error class for all custom application errors.
 *
 * Every custom error extends this to ensure consistent structure across the application.
 * Contains all metadata needed for proper error tracking, logging, and monitoring.
 */
export class BaseError extends Error {
  public readonly name: string;
  public readonly code: string;
  public readonly statusCode: number;
  public readonly context: Record<string, any>;
  public readonly severity: 'critical' | 'error' | 'warning' | 'info';
  public readonly isOperational: boolean;
  public readonly timestamp: string;
  public readonly service: string;
  public correlationId?: string;

  constructor(
    message: string,
    {
      code,
      statusCode = 500,
      context = {},
      severity = 'error' as const,
      isOperational = true,
      correlationId
    }: {
      code: string;
      statusCode?: number;
      context?: Record<string, any>;
      severity?: 'critical' | 'error' | 'warning' | 'info';
      isOperational?: boolean;
      correlationId?: string;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
    this.severity = severity;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();
    this.service = process.env.SERVICE_NAME || 'coovi-api';
    this.correlationId = correlationId;

    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to JSON for logging and API responses
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      context: this.context,
      severity: this.severity,
      timestamp: this.timestamp,
      service: this.service,
      correlationId: this.correlationId,
      stack: this.stack
    };
  }
}
