import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

async function getAdminToken(): Promise<string> {
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  return login.body.data.token as string;
}

describe('Global error handler (A-2)', () => {
  beforeAll(async () => {
    await Product.deleteMany({});
    await Product.create({
      slug: 'error-handler-test-saree',
      name: 'Error Handler Test Saree',
      price: 999,
      images: ['https://picsum.photos/seed/err/800/1200'],
      category: 'Saree',
      stock: 5,
      inStock: true
    });
  });

  it('returns 400 JSON for a malformed JSON body (was an HTML error page)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('JSON');
  });

  it('returns 400 for an invalid product id in PUT (was 500 — CastError)', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .put('/api/products/not-an-object-id')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an invalid product id in DELETE (was 500 — CastError)', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .delete('/api/products/not-an-object-id')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
