import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import authRoutes from './routes/auth';
import productRoutes from './routes/products';
import orderRoutes from './routes/orders';
import { errorHandler } from './middleware/errorHandler';

dotenv.config();

const app: Application = express();

// CORS is LOCKED to the two frontends we run (storefront + admin). Any other
// website's browser JS gets no API access. Origins come from env so production
// can point at the real domains without a code change.
const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Behind a host proxy (Render, Vercel) every request arrives from the proxy's IP. Trusting one proxy hop makes
// req.ip (and so the rate limiters) see the real visitor instead of locking everyone out together.
// Override with TRUST_PROXY (a number of hops, or 0 to disable).
const trustProxy = process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? '1' : '0');
app.set('trust proxy', Number(trustProxy));

// Middleware
app.use(helmet());
app.use(cors({ origin: corsOrigins }));
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

// Health check for uptime monitors and smoke tests: 503 when the database is not connected
app.get('/health', (_req: Request, res: Response) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.status(dbConnected ? 200 : 503).json({
    success: dbConnected,
    status: dbConnected ? 'ok' : 'degraded',
    db: dbConnected ? 'connected' : 'disconnected',
    uptimeSeconds: Math.round(process.uptime())
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
