import { rateLimit, RateLimitRequestHandler } from 'express-rate-limit';

// Rate limits exist to slow down brute-force and abuse, not to punish normal
// users. Limits are skipped in tests (NODE_ENV=test) because a test file may
// make dozens of requests in seconds — all from the same fake IP.
const isTest = (): boolean => process.env.NODE_ENV === 'test';

const tooManyRequests = (message: string) => (_req: any, res: any): void => {
  res.status(429).json({ success: false, message });
};

// Public browsing: generous, mostly stops scrapers hitting the API in a loop
export const readLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  skip: isTest,
  standardHeaders: 'draft-7',
  handler: tooManyRequests('Too many requests, please slow down'),
});

// Login: tight — 5 attempts per 15 minutes is brute-force protection
// (wrong-password tests never hit this because tests skip the limiter)
export const loginLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skip: isTest,
  standardHeaders: 'draft-7',
  handler: tooManyRequests('Too many login attempts, please try again in 15 minutes'),
});

// Order creation: one basket-checkout per ~3 minutes is plenty for a human;
// bots flooding fake COD orders is a real problem for a small shop
export const orderLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  skip: isTest,
  standardHeaders: 'draft-7',
  handler: tooManyRequests('Too many orders from this address, please try again later'),
});
