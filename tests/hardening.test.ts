import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { checkEnv } from '../src/config/env';

const GOOD_PROD_ENV = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://example/coovi',
  JWT_SECRET: 'a'.repeat(40),
  CORS_ORIGINS: 'https://shop.example.com,https://admin.example.com',
  ADMIN_PASSWORD: 'a-long-unique-passphrase-9!',
  DELIVERY_FEE: '60',
} as NodeJS.ProcessEnv;

describe('checkEnv', () => {
  it('accepts a complete production configuration', () => {
    expect(checkEnv(GOOD_PROD_ENV)).toEqual({ errors: [], warnings: [] });
  });

  it('fails production for a missing or short JWT secret and missing database URI', () => {
    const result = checkEnv({ ...GOOD_PROD_ENV, MONGODB_URI: '', JWT_SECRET: 'short' } as NodeJS.ProcessEnv);
    expect(result.errors.join(' ')).toMatch(/MONGODB_URI/);
    expect(result.errors.join(' ')).toMatch(/JWT_SECRET/);
  });

  it('fails production for missing CORS origins, localhost origins and weak admin password', () => {
    expect(checkEnv({ ...GOOD_PROD_ENV, CORS_ORIGINS: '' } as NodeJS.ProcessEnv).errors.join(' ')).toMatch(/CORS_ORIGINS/);
    expect(
      checkEnv({ ...GOOD_PROD_ENV, CORS_ORIGINS: 'http://localhost:3000' } as NodeJS.ProcessEnv).errors.join(' ')
    ).toMatch(/localhost/);
    expect(
      checkEnv({ ...GOOD_PROD_ENV, ADMIN_PASSWORD: 'admin123' } as NodeJS.ProcessEnv).errors.join(' ')
    ).toMatch(/ADMIN_PASSWORD/);
  });

  it('only warns in development', () => {
    const result = checkEnv({ NODE_ENV: 'development', MONGODB_URI: 'x', JWT_SECRET: 'short' } as NodeJS.ProcessEnv);
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('warns about an invalid delivery fee', () => {
    const result = checkEnv({ ...GOOD_PROD_ENV, DELIVERY_FEE: 'free' } as NodeJS.ProcessEnv);
    expect(result.warnings.join(' ')).toMatch(/DELIVERY_FEE/);
  });
});

describe('GET /health', () => {
  it('reports ok when the database is connected', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'ok', db: 'connected' });
  });
});
