/**
 * Error utility functions for route handlers
 *
 * These helpers make it easier to throw structured errors with proper context
 */

import { Request } from 'express';
import {
  ValidationError,
  NotFoundError,
  BusinessError,
  AuthenticationError,
  AuthorizationError,
  DatabaseError
} from '../errors';

/**
 * Get correlation ID from request
 */
export function getCorrelationId(req: Request): string | undefined {
  return (req as any).correlationId;
}

/**
 * Throw validation error with correlation ID
 */
export function throwValidationError(message: string, req: Request, context?: Record<string, any>): never {
  throw new ValidationError(message, {
    ...context,
    correlationId: getCorrelationId(req)
  });
}

/**
 * Throw not found error with correlation ID
 */
export function throwNotFoundError(message: string, req: Request, context?: Record<string, any>): never {
  throw new NotFoundError(message, {
    ...context,
    correlationId: getCorrelationId(req)
  });
}

/**
 * Throw business logic error with correlation ID
 */
export function throwBusinessError(message: string, req: Request, context?: Record<string, any>): never {
  throw new BusinessError(message, {
    ...context,
    correlationId: getCorrelationId(req)
  });
}

/**
 * Throw authentication error with correlation ID
 */
export function throwAuthenticationError(message: string, req: Request, context?: Record<string, any>): never {
  throw new AuthenticationError(message, {
    ...context,
    correlationId: getCorrelationId(req)
  });
}

/**
 * Throw authorization error with correlation ID
 */
export function throwAuthorizationError(message: string, req: Request, context?: Record<string, any>): never {
  throw new AuthorizationError(message, {
    ...context,
    correlationId: getCorrelationId(req)
  });
}

/**
 * Handle database duplicate key error (MongoDB error code 11000)
 */
export function handleDuplicateKeyError(error: any, req: Request, resource: string): never {
  if (error.code === 11000) {
    throw new DatabaseError(`${resource} with this value already exists`, {
      operation: 'insert',
      resource,
      errorCode: 11000,
      correlationId: getCorrelationId(req)
    });
  }
  throw error;
}
