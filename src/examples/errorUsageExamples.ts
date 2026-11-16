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
  AuthenticationError,
  AuthorizationError
} from '../errors';

const router = Router();

// Example 1: Validation in route handler
router.post('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const correlationId = (req as any).correlationId;

    // Validate required fields
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

    // Check for existing user
    const existingUser = await findUserByEmail(req.body.email);
    if (existingUser) {
      throw new BusinessError('User with this email already exists', {
        operation: 'createUser',
        reason: 'duplicate_email',
        email: req.body.email,
        correlationId
      });
    }

    // Create user (wrapped in try-catch for DB errors)
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

    res.status(201).json({
      success: true,
      data: user
    });
  } catch (error) {
    next(error); // Pass to error handler middleware
  }
});

// Example 2: Not found error
router.get('/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const correlationId = (req as any).correlationId;
    const user = await findUserById(req.params.id);

    if (!user) {
      throw new NotFoundError('User not found', {
        resource: 'user',
        id: req.params.id,
        correlationId
      });
    }

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    next(error);
  }
});

// Example 3: Authorization check
router.delete('/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const correlationId = (req as any).correlationId;
    const currentUser = (req as any).admin;

    // Check if user has permission
    if (currentUser.role !== 'owner' && currentUser.id !== req.params.id) {
      throw new AuthorizationError('You do not have permission to delete this user', {
        userId: currentUser.id,
        resource: 'user',
        action: 'delete',
        correlationId
      });
    }

    const user = await findUserById(req.params.id);
    if (!user) {
      throw new NotFoundError('User not found', {
        resource: 'user',
        id: req.params.id,
        correlationId
      });
    }

    await deleteUser(req.params.id);

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    next(error);
  }
});

// Example 4: Business logic validation
router.post('/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const correlationId = (req as any).correlationId;
    const { productId, quantity } = req.body;

    // Get product
    const product = await findProductById(productId);
    if (!product) {
      throw new NotFoundError('Product not found', {
        resource: 'product',
        id: productId,
        correlationId
      });
    }

    // Check stock availability
    if (product.stock < quantity) {
      throw new BusinessError('Insufficient product stock', {
        operation: 'createOrder',
        reason: 'insufficient_stock',
        productId,
        available: product.stock,
        requested: quantity,
        correlationId
      });
    }

    // Check if product is active
    if (!product.active) {
      throw new BusinessError('Product is not available for purchase', {
        operation: 'createOrder',
        reason: 'product_inactive',
        productId,
        correlationId
      });
    }

    const order = await createOrder(req.body);

    res.status(201).json({
      success: true,
      data: order
    });
  } catch (error) {
    next(error);
  }
});

// Example 5: Wrapping database operations
async function findUserById(id: string): Promise<any> {
  try {
    // Your database call here
    return null; // placeholder
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
import { ExternalServiceError } from '../errors';
import axios from 'axios';

async function sendSMS(phone: string, message: string, correlationId: string): Promise<void> {
  try {
    await axios.post('https://sms-gateway.example.com/send', {
      phone,
      message
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.SMS_API_KEY}`,
        'X-Correlation-ID': correlationId
      },
      timeout: 10000
    });
  } catch (error: any) {
    if (error.response) {
      throw new ExternalServiceError('SMS gateway returned an error', {
        serviceName: 'SMSGateway',
        endpoint: '/send',
        requestData: { phone, messageLength: message.length },
        responseData: error.response.data,
        statusCode: error.response.status,
        correlationId
      });
    } else if (error.request) {
      throw new ExternalServiceError('SMS gateway did not respond', {
        serviceName: 'SMSGateway',
        endpoint: '/send',
        requestData: { phone, messageLength: message.length },
        correlationId
      });
    } else {
      throw new ExternalServiceError('Failed to send SMS request', {
        serviceName: 'SMSGateway',
        correlationId
      });
    }
  }
}

// Placeholder functions (replace with actual implementations)
async function findUserByEmail(email: string): Promise<any> { return null; }
async function createUser(data: any): Promise<any> { return {}; }
async function deleteUser(id: string): Promise<void> { }
async function findProductById(id: string): Promise<any> { return null; }
async function createOrder(data: any): Promise<any> { return {}; }

export default router;
