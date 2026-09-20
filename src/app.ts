import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import productRoutes from './routes/products';
import orderRoutes from './routes/orders';
import { errorHandler } from './middleware/errorHandler';

dotenv.config();

const app: Application = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Coovi API Server Running',
    version: '1.0.0',
    endpoints: {
      products: '/api/products',
      orders: '/api/orders',
      auth: '/api/auth'
    }
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Global error handler — must come AFTER all routes (Express matches it by
// its 4-argument signature, no path needed)
app.use(errorHandler);

export default app;
