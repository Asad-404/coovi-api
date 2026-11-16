/**
 * Example usage of structured errors in route handlers
 *
 * This file demonstrates how to use the new error classes throughout the application.
 * Copy these patterns when refactoring existing routes.
 */

import { Router, Request, Response, NextFunction } from 'express';
import {
  ValidationError,
  NotFoundError,
  BusinessError,
  DatabaseError,
  AuthorizationError,
  ExternalServiceError
} from '../errors';

const router = Router();

// Example 1: Validation in route handler
router.post('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const correlationId = (req as any).correlationId as string | undefined;

    if (!req.body.email) {
      throw new ValidationError('Email is required', {
        field: 'email',
        constraint: 'required',
        correlationId
      });
    }

    if (!req.body.password || req.body.password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters', {
        field: 'password',
        value: req.body.password?.length || 0,
        constraint: 'minLength:8',
        correlationId
      });
    }

    const existingUser = await findUserByEmail(req.body.email);
    if (existingUser) {
      throw new BusinessError('User with this email already exists', {
        operation: 'createUser',
        reason: 'duplicate_email',
        correlationId
      });
    }

    let user;
    try {
      user = await createUser(req.body);
    } catch (error: any) {
      throw new DatabaseError('Failed to create user', {
        table: 'users',
        operation: 'insert',
        originalError: error.message,
        correlationId
      });
    }

    res.status(201).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
});

// Example 2: Not found error
router.get('/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const correlationId = (req as any).correlationId as string | undefined;
    const id = req.params['id'] as string;
    const user = await findUserById(id);

    if (!user) {
      throw new NotFoundError('User not found', { resource: 'user', id, correlationId });
    }

    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
});

// Example 3: Authorization check
router.delete('/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const correlationId = (req as any).correlationId as string | undefined;
    const currentUser = (req as any).admin;
    const id = req.params['id'] as string;

    if (currentUser.role !== 'owner' && currentUser.id !== id) {
      throw new AuthorizationError('You do not have permission to delete this user', {
        userId: currentUser.id as string,
        resource: 'user',
        action: 'delete',
        correlationId
      });
    }

    const user = await findUserById(id);
    if (!user) {
      throw new NotFoundError('User not found', { resource: 'user', id, correlationId });
    }

    await deleteUser(id);

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// Example 4: Business logic validation
router.post('/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const correlationId = (req as any).correlationId as string | undefined;
    const { productId, quantity } = req.body as { productId: string; quantity: number };

    const product = await findProductById(productId);
    if (!product) {
      throw new NotFoundError('Product not found', { resource: 'product', id: productId, correlationId });
    }

    if (product.stock < quantity) {
      throw new BusinessError('Insufficient product stock', {
        operation: 'createOrder',
        reason: 'insufficient_stock',
        correlationId
      });
    }

    if (!product.active) {
      throw new BusinessError('Product is not available for purchase', {
        operation: 'createOrder',
        reason: 'product_inactive',
        correlationId
      });
    }

    const order = await createOrder(req.body);
    res.status(201).json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
});

// Example 5: Wrapping database operations
async function findUserById(id: string): Promise<any> {
  try {
    void id; // placeholder — replace with real DB call
    return null;
  } catch (error: any) {
    throw new DatabaseError('Failed to fetch user', {
      table: 'users',
      operation: 'select',
      params: { id },
      originalError: error.message
    });
  }
}

// Example 6: Handling external service errors
async function sendNotification(phone: string, text: string, correlationId?: string): Promise<void> {
  const url = 'https://sms-gateway.example.com/send';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SMS_API_KEY ?? ''}`,
        ...(correlationId ? { 'X-Correlation-ID': correlationId } : {})
      },
      body: JSON.stringify({ phone, text }),
      signal: AbortSignal.timeout(10_000)
    });

    if (!res.ok) {
      throw new ExternalServiceError('SMS gateway returned an error', {
        serviceName: 'SMSGateway',
        endpoint: '/send',
        requestData: { phone, textLength: text.length },
        responseData: await res.json().catch(() => null),
        statusCode: res.status,
        correlationId
      });
    }
  } catch (error: any) {
    if (error instanceof ExternalServiceError) throw error;

    throw new ExternalServiceError('Failed to reach SMS gateway', {
      serviceName: 'SMSGateway',
      endpoint: '/send',
      requestData: { phone, textLength: text.length },
      correlationId
    });
  }
}

// Placeholder functions — replace with real implementations
async function findUserByEmail(_email: string): Promise<any> { return null; }
async function createUser(_data: any): Promise<any> { return {}; }
async function deleteUser(_id: string): Promise<void> { /* no-op */ }
async function findProductById(_id: string): Promise<any> { return null; }
async function createOrder(_data: any): Promise<any> { return {}; }

// Export so the notification helper is reachable and tsc treats every symbol as used
export { sendNotification };
export default router;
