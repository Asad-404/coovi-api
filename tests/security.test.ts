import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';

// A-5: helmet security headers + CORS locked to our own frontends
describe('Security headers and CORS (A-5)', () => {
  it('sends helmet security headers on every response', async () => {
    const res = await request(app).get('/');

    // nosniff stops browsers from guessing a file type (MIME sniffing attacks)
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // frame-options stops other sites embedding the API in an iframe
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('allows API calls from the storefront origin', async () => {
    const res = await request(app)
      .get('/api/products')
      .set('Origin', 'http://localhost:3000');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('blocks API calls from an unknown origin (no CORS header back)', async () => {
    const res = await request(app)
      .get('/api/products')
      .set('Origin', 'https://evil.example');

    // CORS is enforced by the BROWSER, not the server — the server just
    // refuses to say "evil.example may read my response"
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// A-4: rate limiting. Our limiters skip when NODE_ENV=test, so the whole test
// suite can hammer the API. Here we temporarily flip NODE_ENV to prove the
// limiter really fires.
describe('Rate limiting (A-4)', () => {
  it('locks login after 5 failed attempts from one IP for 15 minutes', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // un-skip the limiter
    try {
      const attempts = [] as number[];
      for (let i = 0; i < 7; i++) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email: 'brute@force.example', password: 'wrong' });
        attempts.push(res.status);
      }

      // first 5 get a normal 401 (wrong credentials)...
      expect(attempts.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      // ...then the limiter steps in with 429 Too Many Requests
      expect(attempts.slice(5)).toEqual([429, 429]);
    } finally {
      process.env.NODE_ENV = originalEnv; // never leave this changed
    }
  });

  it('is skipped in tests: many rapid reads never see 429', async () => {
    const statuses = await Promise.all(
      Array.from({ length: 30 }, () => request(app).get('/api/products').then((r) => r.status))
    );
    expect(statuses.every((s) => s === 200)).toBe(true);
  });
});
