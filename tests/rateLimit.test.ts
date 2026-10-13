import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CLIENT_IP_HEADER, publicLimiter, STOREFRONT_KEY_HEADER } from '../src/middleware/rateLimiters';

const SECRET = 'k'.repeat(40);

// A tiny app with a limiter that is NOT skipped in tests: 2 requests per shopper, 4 for the storefront bucket
function buildApp() {
  const app = express();
  app.get(
    '/',
    publicLimiter({ windowMs: 60 * 1000, limit: 2, storefrontLimit: 4, message: 'slow down', skip: () => false }),
    (_req, res) => {
      res.json({ success: true });
    }
  );
  return app;
}

async function statuses(app: express.Express, count: number, headers: Record<string, string> = {}): Promise<number[]> {
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    let req = request(app).get('/');
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
    result.push((await req).status);
  }
  return result;
}

describe('public rate limits and the storefront server', () => {
  const original = process.env.STOREFRONT_API_KEY;
  beforeEach(() => {
    process.env.STOREFRONT_API_KEY = SECRET;
  });
  afterEach(() => {
    process.env.STOREFRONT_API_KEY = original;
  });

  it('limits an ordinary visitor by their own address with the envelope message', async () => {
    const app = buildApp();
    expect(await statuses(app, 3)).toEqual([200, 200, 429]);
    const res = await request(app).get('/');
    expect(res.body).toEqual({ success: false, message: 'slow down' });
  });

  it('gives the storefront server its own, larger bucket', async () => {
    const app = buildApp();
    expect(await statuses(app, 5, { [STOREFRONT_KEY_HEADER]: SECRET })).toEqual([200, 200, 200, 200, 429]);
    // Shoppers calling from the same address are not affected by the storefront's usage
    expect(await statuses(app, 1)).toEqual([200]);
  });

  it('limits each shopper separately when the storefront forwards their address', async () => {
    const app = buildApp();
    const shopperA = { [STOREFRONT_KEY_HEADER]: SECRET, [CLIENT_IP_HEADER]: '203.0.113.7' };
    const shopperB = { [STOREFRONT_KEY_HEADER]: SECRET, [CLIENT_IP_HEADER]: '2001:db8::1' };
    expect(await statuses(app, 3, shopperA)).toEqual([200, 200, 429]);
    expect(await statuses(app, 2, shopperB)).toEqual([200, 200]);
  });

  it('ignores a forwarded address or a key that does not match the secret', async () => {
    const app = buildApp();
    const forged = { [STOREFRONT_KEY_HEADER]: 'wrong', [CLIENT_IP_HEADER]: '203.0.113.8' };
    expect(await statuses(app, 3, forged)).toEqual([200, 200, 429]);
    // A different forged address still lands in the caller's own bucket
    expect(await statuses(app, 1, { ...forged, [CLIENT_IP_HEADER]: '203.0.113.9' })).toEqual([429]);
  });

  it('falls back to the storefront bucket when the forwarded address is not a valid IP', async () => {
    const app = buildApp();
    const bad = { [STOREFRONT_KEY_HEADER]: SECRET, [CLIENT_IP_HEADER]: 'not-an-ip' };
    expect(await statuses(app, 5, bad)).toEqual([200, 200, 200, 200, 429]);
  });

  it('treats every request as an ordinary visitor when no secret is configured', async () => {
    delete process.env.STOREFRONT_API_KEY;
    const app = buildApp();
    expect(await statuses(app, 3, { [STOREFRONT_KEY_HEADER]: '' })).toEqual([200, 200, 429]);
  });
});
