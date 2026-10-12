import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import app from '../src/app';
import { signUpload } from '../src/routes/uploads';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };
const TEST_SECRET = 'test-cloudinary-secret';

async function token(): Promise<string> {
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  return login.body.data.token as string;
}

beforeEach(() => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
  process.env.CLOUDINARY_API_KEY = '123456789012345';
  process.env.CLOUDINARY_API_SECRET = TEST_SECRET;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signUpload', () => {
  it('sorts the parameters, appends the secret and returns the SHA-1 hex', () => {
    const expected = createHash('sha1')
      .update(`folder=coovi/products&timestamp=1700000000${TEST_SECRET}`)
      .digest('hex');

    // Given out of order on purpose: the result must not depend on key order
    expect(signUpload({ timestamp: 1700000000, folder: 'coovi/products' }, TEST_SECRET)).toBe(expected);
  });
});

describe('POST /api/uploads/signature', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/uploads/signature');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns a signature Cloudinary will accept, and never the secret', async () => {
    const adminToken = await token();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1700000000 * 1000));

    const res = await request(app)
      .post('/api/uploads/signature')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      cloudName: 'demo-cloud',
      apiKey: '123456789012345',
      timestamp: 1700000000,
      folder: 'coovi/products',
      signature: signUpload({ folder: 'coovi/products', timestamp: 1700000000 }, TEST_SECRET)
    });
    expect(JSON.stringify(res.body)).not.toContain(TEST_SECRET);
  });

  it('returns 503 when Cloudinary is not configured', async () => {
    delete process.env.CLOUDINARY_API_SECRET;

    const res = await request(app)
      .post('/api/uploads/signature')
      .set('Authorization', `Bearer ${await token()}`);

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });
});
