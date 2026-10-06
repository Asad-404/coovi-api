import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

let token = '';
let productId = '';

async function createOrder(quantity = 1): Promise<string> {
  const res = await request(app).post('/api/orders').send({
    customerName: 'Flow Test Customer',
    phone: '01712345678',
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    items: [{ productId, quantity }]
  });
  expect(res.status).toBe(201);
  return res.body.data._id as string;
}

const setStatus = (orderId: string, status: string) =>
  request(app).patch(`/api/orders/${orderId}/status`).set('Authorization', `Bearer ${token}`).send({ status });

const editOrder = (orderId: string, body: object) =>
  request(app).patch(`/api/orders/${orderId}`).set('Authorization', `Bearer ${token}`).send(body);

const stock = async () => (await Product.findById(productId).select('stock'))?.stock;

beforeAll(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const product = await Product.create({
    slug: 'flow-test-saree',
    name: 'Flow Test Saree',
    price: 1000,
    images: ['https://picsum.photos/seed/flow/800/1200'],
    category: 'Saree',
    stock: 50,
    inStock: true
  });
  productId = String(product._id);
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  token = login.body.data.token;
});

describe('PATCH /api/orders/:id/status — forward-only flow', () => {
  it('walks Pending → Processing → Shipped → Delivered', async () => {
    const orderId = await createOrder();
    for (const status of ['Processing', 'Shipped', 'Delivered']) {
      const res = await setStatus(orderId, status);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(status);
    }
  });

  it('refuses moving back to Pending, and does not touch stock', async () => {
    const orderId = await createOrder(2);
    await setStatus(orderId, 'Processing');
    const before = await stock();

    const res = await setStatus(orderId, 'Pending');
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Can't move an order from Processing to Pending");

    // Without the rule, Pending → Processing again would take the stock a second time
    expect(await stock()).toBe(before);
    expect((await Order.findById(orderId))?.status).toBe('Processing');
  });

  it('refuses cancelling after shipping (stock would never come back)', async () => {
    const orderId = await createOrder();
    await setStatus(orderId, 'Processing');
    await setStatus(orderId, 'Shipped');

    const res = await setStatus(orderId, 'Cancelled');
    expect(res.status).toBe(409);
  });

  it('allows cancelling a Pending order without changing stock', async () => {
    const orderId = await createOrder(3);
    const before = await stock();

    const res = await setStatus(orderId, 'Cancelled');
    expect(res.status).toBe(200);
    expect(await stock()).toBe(before);
  });

  it('treats Delivered and Cancelled as final', async () => {
    const cancelled = await createOrder();
    await setStatus(cancelled, 'Cancelled');
    const res = await setStatus(cancelled, 'Processing');
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Cancelled is final');
  });

  it('rejects the same status with 409 and an unknown status with 400', async () => {
    const orderId = await createOrder();
    expect((await setStatus(orderId, 'Pending')).status).toBe(409);
    expect((await setStatus(orderId, 'Lost')).status).toBe(400);
  });

  it('takes stock only once when two confirmations race', async () => {
    const orderId = await createOrder(4);
    const before = (await stock()) ?? 0;

    const results = await Promise.all([setStatus(orderId, 'Processing'), setStatus(orderId, 'Processing')]);
    const codes = results.map((r) => r.status).sort();

    expect(codes).toEqual([200, 409]);
    expect(await stock()).toBe(before - 4);
  });

  it('returns stock only once when two cancellations race', async () => {
    const orderId = await createOrder(4);
    await setStatus(orderId, 'Processing');
    const before = (await stock()) ?? 0;

    const results = await Promise.all([setStatus(orderId, 'Cancelled'), setStatus(orderId, 'Cancelled')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await stock()).toBe(before + 4);
  });

  it('leaves the order Pending when confirmation fails for stock', async () => {
    const orderId = await createOrder(1);
    const saved = await stock();
    await Product.updateOne({ _id: productId }, { $set: { stock: 0 } });

    const res = await setStatus(orderId, 'Processing');
    expect(res.status).toBe(409);
    expect((await Order.findById(orderId))?.status).toBe('Pending');

    await Product.updateOne({ _id: productId }, { $set: { stock: saved } });
  });
});

describe('PATCH /api/orders/:id — edit customer details', () => {
  it('requires an admin token', async () => {
    const orderId = await createOrder();
    const res = await request(app).patch(`/api/orders/${orderId}`).send({ notes: 'call first' });
    expect(res.status).toBe(401);
  });

  it('updates address, phone and notes', async () => {
    const orderId = await createOrder();
    const res = await editOrder(orderId, {
      address: 'Flat 3B, Road 27, Banani, Dhaka',
      phone: '01898765432',
      notes: 'Call before delivery'
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      address: 'Flat 3B, Road 27, Banani, Dhaka',
      phone: '01898765432',
      notes: 'Call before delivery'
    });
  });

  it('refuses to change items, prices or totals', async () => {
    const orderId = await createOrder();
    const res = await editOrder(orderId, { total: 1 });
    expect(res.status).toBe(400);
    expect((await Order.findById(orderId))?.total).not.toBe(1);
  });

  it('validates the fields like checkout does', async () => {
    const orderId = await createOrder();
    expect((await editOrder(orderId, { phone: '12345' })).status).toBe(400);
    expect((await editOrder(orderId, { address: 'x' })).status).toBe(400);
    expect((await editOrder(orderId, {})).status).toBe(400);
  });

  it('freezes delivered and cancelled orders', async () => {
    const orderId = await createOrder();
    await setStatus(orderId, 'Cancelled');
    const res = await editOrder(orderId, { notes: 'too late' });
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown order', async () => {
    const res = await editOrder('64b000000000000000000000', { notes: 'hi' });
    expect(res.status).toBe(404);
  });
});
