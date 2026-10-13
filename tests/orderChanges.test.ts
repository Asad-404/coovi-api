import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

let token = '';
let productId = '';

async function placeOrder(): Promise<{ _id: string; orderNumber: string }> {
  const res = await request(app).post('/api/orders').send({
    customerName: 'Changes Test Customer',
    phone: '01712345678',
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    items: [{ productId, quantity: 1 }]
  });
  expect(res.status).toBe(201);
  return res.body.data;
}

// Pretend an order was last touched long ago, without the save itself bumping updatedAt
async function age(orderId: string): Promise<void> {
  await Order.updateOne({ _id: orderId }, { $set: { updatedAt: LONG_AGO } }, { timestamps: false });
}

function listChanges(since?: string) {
  return request(app)
    .get('/api/orders')
    .query(since === undefined ? {} : { updatedSince: since })
    .set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const product = await Product.create({
    slug: 'changes-test-saree',
    name: 'Changes Test Saree',
    price: 2000,
    images: ['https://picsum.photos/seed/changes/800/1200'],
    stock: 10
  });
  productId = String(product._id);
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  token = login.body.data.token;
});

describe('GET /api/orders?updatedSince=', () => {
  it('returns the server time with every list', async () => {
    const before = Date.now();
    const res = await listChanges();

    expect(res.status).toBe(200);
    expect(new Date(res.body.serverTime).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('returns only orders created or changed since the given time', async () => {
    const old = await placeOrder();
    const cancelledLater = await placeOrder();
    await age(old._id);
    await age(cancelledLater._id);

    const { body: first } = await listChanges(new Date(LONG_AGO.getTime() + 1000).toISOString());
    expect(first.data).toEqual([]);

    // Something happens after the admin's last check: a status change and a new order
    const since = (await listChanges()).body.serverTime as string;
    const cancel = await request(app)
      .patch(`/api/orders/${cancelledLater._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'Cancelled' });
    expect(cancel.status).toBe(200);
    const fresh = await placeOrder();

    const res = await listChanges(since);
    expect(res.status).toBe(200);
    const numbers = res.body.data.map((o: { orderNumber: string }) => o.orderNumber);
    expect(numbers).toEqual([cancelledLater.orderNumber, fresh.orderNumber]);
    expect(res.body.data[0].status).toBe('Cancelled');
    expect(numbers).not.toContain(old.orderNumber);
  });

  it('rejects a time that is not an ISO date-time', async () => {
    const res = await listChanges('yesterday');

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('updatedSince');
  });

  it('stays admin only', async () => {
    const res = await request(app).get('/api/orders').query({ updatedSince: new Date().toISOString() });

    expect(res.status).toBe(401);
  });
});
