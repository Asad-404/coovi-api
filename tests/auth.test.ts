import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

describe('POST /api/auth/login', () => {
  it('returns 200 with a token for correct credentials', async () => {
    const res = await request(app).post('/api/auth/login').send(TEST_ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.admin.email).toBe(TEST_ADMIN.email);
    expect(res.body.data.admin.passwordHash).toBeUndefined();
  });

  it('returns 401 for a wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_ADMIN.email, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 (same message) for an unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@coovi.com', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  });

  it('returns 400 when fields are missing', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: TEST_ADMIN.email });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the admin for a valid token', async () => {
    const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
    const token = login.body.data.token;

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(TEST_ADMIN.email);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
