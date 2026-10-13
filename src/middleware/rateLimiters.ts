import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { ipKeyGenerator, rateLimit, RateLimitRequestHandler } from 'express-rate-limit';

// Rate limits exist to slow down brute-force and abuse, not to punish normal
// users. Limits are skipped in tests (NODE_ENV=test) because a test file may
// make dozens of requests in seconds — all from the same fake IP.
const isTest = (): boolean => process.env.NODE_ENV === 'test';

const tooManyRequests = (message: string) => (_req: any, res: any): void => {
  res.status(429).json({ success: false, message });
};

// The storefront loads product pages and order confirmations on Vercel's servers, so to this API
// thousands of shoppers look like a handful of Vercel IP addresses sharing one limit. The storefront
// server proves who it is with a shared secret header (STOREFRONT_API_KEY on both sides) and then:
// - may name the shopper's own IP in x-coovi-client-ip, which is used as the limit key instead, and
// - without a shopper IP (cached product data, not tied to one shopper) gets its own, larger bucket.
// Browsers never see the secret, so anyone else is still limited by their own IP.
export const STOREFRONT_KEY_HEADER = 'x-coovi-storefront-key';
export const CLIENT_IP_HEADER = 'x-coovi-client-ip';

export function isStorefrontServer(req: Request, secret = process.env.STOREFRONT_API_KEY): boolean {
  const sent = req.get(STOREFRONT_KEY_HEADER);
  if (!secret || !sent) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The shopper IP the storefront server forwarded, or undefined when the request is not from the
// storefront server or the header is not a single valid IP address
export function forwardedClientIp(req: Request, secret = process.env.STOREFRONT_API_KEY): string | undefined {
  if (!isStorefrontServer(req, secret)) return undefined;
  const ip = req.get(CLIENT_IP_HEADER)?.trim();
  return ip && isIP(ip) ? ip : undefined;
}

const STOREFRONT_BUCKET = 'storefront-server';

export function limiterKey(req: Request, secret = process.env.STOREFRONT_API_KEY): string {
  const clientIp = forwardedClientIp(req, secret);
  if (clientIp) return ipKeyGenerator(clientIp);
  if (isStorefrontServer(req, secret)) return STOREFRONT_BUCKET;
  return ipKeyGenerator(req.ip ?? '');
}

interface PublicLimiterOptions {
  windowMs: number;
  limit: number;
  // Limit for the storefront server's shared bucket (requests not tied to one shopper)
  storefrontLimit: number;
  message: string;
  skip?: () => boolean;
}

// Exported so tests can build one with the skip switched off
export function publicLimiter({ windowMs, limit, storefrontLimit, message, skip = isTest }: PublicLimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit: (req) => (limiterKey(req) === STOREFRONT_BUCKET ? storefrontLimit : limit),
    keyGenerator: (req) => limiterKey(req),
    skip,
    standardHeaders: 'draft-7',
    handler: tooManyRequests(message),
  });
}

// Public browsing: generous, mostly stops scrapers hitting the API in a loop. The storefront server
// caches product data for a minute, so 1000 a minute is far more than it needs even when busy.
export const readLimiter: RateLimitRequestHandler = publicLimiter({
  windowMs: 60 * 1000,
  limit: 100,
  storefrontLimit: 1000,
  message: 'Too many requests, please slow down',
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

// Order lookup by order number: tight, because probing order numbers with
// guessed phones is an enumeration attack (and every probe hits the DB)
export const orderLookupLimiter: RateLimitRequestHandler = publicLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  // The storefront normally forwards the shopper's IP for lookups, so this bucket is only a fallback
  storefrontLimit: 200,
  message: 'Too many order lookups, please try again in a minute',
});
