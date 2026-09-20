import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

const VALID_PRODUCT = {
  slug: 'test-saree',
  name: 'Test Saree',
  price: 999,
  images: ['https://picsum.photos/seed/test/800/1200'],
  category: 'Saree',
  stock: 5,
  inStock: true,
};

async function getAdminToken(): Promise<string> {
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  return login.body.data.token as string;
}

describe('GET /api/products (query validation)', () => {
  beforeAll(async () => {
    await Product.deleteMany({});
    await Product.create(VALID_PRODUCT);
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

  it('does not crash on regex metacharacters in search (was a 500)', async () => {
    const res = await request(app).get('/api/products?search=(');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('clamps a negative page to 1 (was a 500)', async () => {
    const res = await request(app).get('/api/products?page=-1');
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(1);
  });

  it('clamps an oversized limit to 50', async () => {
    const res = await request(app).get('/api/products?limit=99999');
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(50);
  });
});

describe('POST /api/products (body validation)', () => {
  it('rejects an invalid body with 400, not 500', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'No slug, no price' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('rejects unexpected fields (mass assignment)', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PRODUCT, slug: 'brand-new-saree', _id: '000000000000000000000000' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed slug', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PRODUCT, slug: 'My Saree!' });
    expect(res.status).toBe(400);
  });

  it('creates a product for a valid body + token', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PRODUCT, slug: 'another-test-saree' });
    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe('another-test-saree');
    expect(res.body.data._id).toBeDefined();
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/products').send(VALID_PRODUCT);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/products/:id (body validation)', () => {
  it('rejects an invalid body with 400', async () => {
    const token = await getAdminToken();
    const product = await Product.findOne({ slug: 'test-saree' });
    const res = await request(app)
      .put(`/api/products/${product!._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ price: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
