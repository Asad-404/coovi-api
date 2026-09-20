import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';

describe('GET /api/products', () => {
  beforeAll(async () => {
    await Product.deleteMany({});
    await Product.create({
      slug: 'test-saree',
      name: 'Test Saree',
      price: 999,
      images: ['https://picsum.photos/seed/test/800/1200'],
      category: 'Saree',
      stock: 5,
      inStock: true,
    });
  });

  it('returns 200 with the seeded product', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Test Saree');
    expect(res.body.data[0].price).toBe(999);
  });

  it('reports pagination metadata', async () => {
    const res = await request(app).get('/api/products?page=1&limit=12');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 12, total: 1 });
  });

  it('returns 404 JSON for unknown routes', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
