import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

async function getAdminToken(): Promise<string> {
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  return login.body.data.token as string;
}

async function createOrder(productId: string, quantity: number): Promise<string> {
  const res = await request(app).post('/api/orders').send({
    customerName: 'Stock Test Customer',
    phone: '01712345678',
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    items: [{ productId, quantity }]
  });
  expect(res.status).toBe(201);
  return res.body.data._id as string;
}

async function setStatus(token: string, orderId: string, status: string) {
  return request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status });
}

let redId = '';
let blueId = '';

beforeAll(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const created = await Product.create([
    {
      slug: 'stock-test-red-saree',
      name: 'Red Stock Saree',
      price: 1000,
      images: ['https://picsum.photos/seed/stockred/800/1200'],
      category: 'Saree',
      stock: 5,
      inStock: true
    },
    {
      slug: 'stock-test-blue-saree',
      name: 'Blue Stock Saree',
      price: 250,
      images: ['https://picsum.photos/seed/stockblue/800/1200'],
      category: 'Saree',
      stock: 2,
      inStock: true
    }
  ]);
  redId = String(created[0]._id);
  blueId = String(created[1]._id);
});

describe('Stock integrity on PATCH /api/orders/:id/status (A-3)', () => {
  it('decrements stock atomically when Pending -> Processing', async () => {
    const token = await getAdminToken();
    const orderId = await createOrder(redId, 2); // stock was 5

    const res = await setStatus(token, orderId, 'Processing');
    expect(res.status).toBe(200);

    const red = await Product.findById(redId).select('stock');
    expect(red?.stock).toBe(3);
  });

  it('rejects confirmation with 409 when stock is insufficient, and changes nothing', async () => {
    const token = await getAdminToken();
    // Order passes the creation check while stock is 3, then stock drops
    const orderId = await createOrder(redId, 2);
    await Product.updateOne({ _id: redId }, { $set: { stock: 1 } });

    const res = await setStatus(token, orderId, 'Processing');
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Insufficient stock');

    // the order must stay Pending and the stock untouched
    const order = await Order.findById(orderId).select('status');
    expect(order?.status).toBe('Pending');
    const red = await Product.findById(redId).select('stock');
    expect(red?.stock).toBe(1);
  });

  it('rolls back earlier decrements when a later item in the same order fails', async () => {
    const token = await getAdminToken();

    // The previous test left red at 1 — put it back so creation passes
    await Product.updateOne({ _id: redId }, { $set: { stock: 3 } });

    // Both items pass the creation check (blue: 2/2, red: 2/3)...
    const res = await request(app).post('/api/orders').send({
      customerName: 'Rollback Test Customer',
      phone: '01712345678',
      address: 'House 12, Road 5, Dhanmondi, Dhaka',
      items: [
        { productId: blueId, quantity: 2 }, // blue has exactly 2 — decrement succeeds
        { productId: redId, quantity: 2 } // red has 3 — decrement succeeds
      ]
    });
    expect(res.status).toBe(201);
    const orderId = res.body.data._id;

    // ...then stock drops before the admin confirms
    await Product.updateOne({ _id: redId }, { $set: { stock: 1 } });

    const patchRes = await setStatus(token, orderId, 'Processing');
    expect(patchRes.status).toBe(409);

    // blue's decrement must have been RESTORED (not left at 0)
    const blue = await Product.findById(blueId).select('stock');
    expect(blue?.stock).toBe(2);
  });

  it('restores stock when Processing -> Cancelled', async () => {
    const token = await getAdminToken();
    await Product.updateOne({ _id: redId }, { $set: { stock: 3 } }); // reset from earlier tests
    const orderId = await createOrder(redId, 2); // red stock is 3

    await setStatus(token, orderId, 'Processing'); // stock drops to 1
    const res = await setStatus(token, orderId, 'Cancelled');

    expect(res.status).toBe(200);
    const red = await Product.findById(redId).select('stock');
    expect(red?.stock).toBe(3);
  });

  it('never allows stock to go negative, even if the DB is changed behind the API', async () => {
    const token = await getAdminToken();
    // Create an order while stock allows it, then an admin edits stock down
    const orderId = await createOrder(blueId, 2);
    await Product.updateOne({ _id: blueId }, { $set: { stock: 1 } });

    const res = await setStatus(token, orderId, 'Processing');
    expect(res.status).toBe(409);

    const blue = await Product.findById(blueId).select('stock');
    expect((blue?.stock ?? 0)).toBeGreaterThanOrEqual(0);
    expect(blue?.stock).toBe(1); // untouched, not -1
  });
});
