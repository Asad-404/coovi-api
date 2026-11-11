import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

// A status change and the stock it moves are written in one transaction. These tests make a
// database write fail partway through (as a crash or a dropped connection would) and check
// that nothing is left half-done: the order keeps its old status and history, and no stock moved.

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

let token = '';
let redId = '';
let blueId = '';

async function placeOrder(items: { productId: string; quantity: number }[]): Promise<string> {
  const res = await request(app).post('/api/orders').send({
    customerName: 'Transaction Test Customer',
    phone: '01712345678',
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    items
  });
  expect(res.status).toBe(201);
  return res.body.data._id as string;
}

function setStatus(orderId: string, status: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status, ...extra });
}

async function stockOf(productId: string): Promise<number | undefined> {
  return (await Product.findById(productId).select('stock'))?.stock;
}

// Lets the first `okCalls` calls through, then fails like a lost database connection
function failAfter<T extends object, K extends keyof T>(target: T, method: K, okCalls: number) {
  const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
  let calls = 0;
  return vi.spyOn(target, method as never).mockImplementation(((...args: unknown[]) => {
    calls += 1;
    if (calls > okCalls) return Promise.reject(new Error('Simulated database failure'));
    return original(...args);
  }) as never);
}

// The error handler logs the 500; keep the test output clean
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const created = await Product.create([
    {
      slug: 'tx-test-red-saree',
      name: 'Red Transaction Saree',
      price: 1000,
      images: ['https://picsum.photos/seed/txred/800/1200'],
      stock: 5
    },
    {
      slug: 'tx-test-blue-saree',
      name: 'Blue Transaction Saree',
      price: 800,
      images: ['https://picsum.photos/seed/txblue/800/1200'],
      stock: 5,
      allowPreorder: true,
      preorderDays: 15
    }
  ]);
  redId = String(created[0]._id);
  blueId = String(created[1]._id);

  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  token = login.body.data.token as string;
});

describe('Status and stock change together or not at all', () => {
  it('confirming: a failure after the first item was taken leaves the order Pending and all stock in place', async () => {
    const orderId = await placeOrder([
      { productId: redId, quantity: 2 },
      { productId: blueId, quantity: 1 }
    ]);

    // Red's decrement goes through, blue's fails
    failAfter(Product, 'updateOne', 1);
    const res = await setStatus(orderId, 'Processing');
    vi.restoreAllMocks();

    expect(res.status).toBe(500);
    const order = await Order.findById(orderId);
    expect(order?.status).toBe('Pending');
    expect(order?.statusHistory.map((h) => h.to)).toEqual(['Pending']);
    expect(await stockOf(redId)).toBe(5);
    expect(await stockOf(blueId)).toBe(5);

    // Nothing is stuck: the same confirmation works once the database is back
    const retry = await setStatus(orderId, 'Processing');
    expect(retry.status).toBe(200);
    expect(await stockOf(redId)).toBe(3);
    expect(await stockOf(blueId)).toBe(4);
  });

  it('confirming: a failure while turning a sold-out line into a pre-order rolls back the stock already taken', async () => {
    const orderId = await placeOrder([
      { productId: redId, quantity: 1 },
      { productId: blueId, quantity: 2 }
    ]);
    // Blue sells out after the order was placed, so confirming makes that line a pre-order
    await Product.updateOne({ _id: blueId }, { $set: { stock: 0 } });

    // The claim (findOneAndUpdate) goes through; the pre-order write fails
    failAfter(Order, 'updateOne', 0);
    const res = await setStatus(orderId, 'Processing');
    vi.restoreAllMocks();

    expect(res.status).toBe(500);
    const order = await Order.findById(orderId);
    expect(order?.status).toBe('Pending');
    expect(order?.items.map((i) => i.preorder)).toEqual([false, false]);
    expect(await stockOf(redId)).toBe(5);
    expect(await stockOf(blueId)).toBe(0);
  });

  it('cancelling: a failure while giving stock back leaves the order Processing and stock as it was', async () => {
    const orderId = await placeOrder([
      { productId: redId, quantity: 2 },
      { productId: blueId, quantity: 1 }
    ]);
    expect((await setStatus(orderId, 'Processing')).status).toBe(200);
    expect(await stockOf(redId)).toBe(3);
    expect(await stockOf(blueId)).toBe(4);

    failAfter(Product, 'updateOne', 1);
    const res = await setStatus(orderId, 'Cancelled', { reason: 'Customer changed their mind' });
    vi.restoreAllMocks();

    expect(res.status).toBe(500);
    const order = await Order.findById(orderId);
    expect(order?.status).toBe('Processing');
    expect(order?.cancelReason).toBeUndefined();
    expect(order?.statusHistory.map((h) => h.to)).toEqual(['Pending', 'Processing']);
    expect(await stockOf(redId)).toBe(3);
    expect(await stockOf(blueId)).toBe(4);
  });

  it('returning: a failure while restocking leaves the order Shipped and stock as it was', async () => {
    const orderId = await placeOrder([
      { productId: redId, quantity: 1 },
      { productId: blueId, quantity: 1 }
    ]);
    expect((await setStatus(orderId, 'Processing')).status).toBe(200);
    expect((await setStatus(orderId, 'Shipped')).status).toBe(200);

    failAfter(Product, 'updateOne', 1);
    const res = await setStatus(orderId, 'Returned', { reason: 'Refused at the door' });
    vi.restoreAllMocks();

    expect(res.status).toBe(500);
    const order = await Order.findById(orderId);
    expect(order?.status).toBe('Shipped');
    expect(order?.returnedAt).toBeUndefined();
    expect(await stockOf(redId)).toBe(4);
    expect(await stockOf(blueId)).toBe(4);
  });

  it('insufficient stock still answers 409 and leaves nothing behind', async () => {
    const orderId = await placeOrder([
      { productId: redId, quantity: 2 },
      { productId: blueId, quantity: 1 }
    ]);
    // The short line (red, no pre-order option) comes second, so blue's decrement
    // has already happened when the refusal rolls everything back
    const otherId = await placeOrder([
      { productId: blueId, quantity: 1 },
      { productId: redId, quantity: 4 }
    ]);
    await Product.updateOne({ _id: redId }, { $set: { stock: 3 } });

    const res = await setStatus(otherId, 'Processing');
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Insufficient stock');
    expect((await Order.findById(otherId))?.status).toBe('Pending');
    expect((await Order.findById(otherId))?.statusHistory).toHaveLength(1);
    expect(await stockOf(blueId)).toBe(5);
    expect(await stockOf(redId)).toBe(3);

    // The first order still confirms normally
    expect((await setStatus(orderId, 'Processing')).status).toBe(200);
  });

  it('two admins confirming at once take the stock only once', async () => {
    const orderId = await placeOrder([{ productId: redId, quantity: 2 }]);

    const results = await Promise.all([setStatus(orderId, 'Processing'), setStatus(orderId, 'Processing')]);
    const codes = results.map((r) => r.status).sort();

    expect(codes).toEqual([200, 409]);
    expect(await stockOf(redId)).toBe(3);
    expect((await Order.findById(orderId))?.statusHistory).toHaveLength(2);
  });
});
