import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

let token = '';
let sareeId = '';
let preorderId = '';

async function getAdminToken(): Promise<string> {
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  return login.body.data.token as string;
}

async function placeOrder(items: { productId: string; quantity: number }[]): Promise<string> {
  const res = await request(app).post('/api/orders').send({
    customerName: 'Return Test Customer',
    phone: '01712345678',
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    items
  });
  expect(res.status).toBe(201);
  return res.body.data._id as string;
}

function setStatus(orderId: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

// Walks an order forward through the normal statuses
async function moveTo(orderId: string, statuses: string[]): Promise<void> {
  for (const status of statuses) {
    const res = await setStatus(orderId, { status });
    expect(res.status).toBe(200);
  }
}

async function stockOf(productId: string): Promise<number> {
  const product = await Product.findById(productId).select('stock');
  return product!.stock;
}

beforeEach(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const created = await Product.create([
    {
      slug: 'return-test-silk',
      name: 'Silk Return Saree',
      price: 3000,
      images: ['https://picsum.photos/seed/return/800/1200'],
      stock: 5
    },
    {
      slug: 'return-test-katan',
      name: 'Katan Preorder Saree',
      price: 5000,
      images: ['https://picsum.photos/seed/returnpre/800/1200'],
      stock: 0,
      allowPreorder: true,
      preorderDays: 20
    }
  ]);
  sareeId = String(created[0]._id);
  preorderId = String(created[1]._id);
  token = await getAdminToken();
});

describe('Refused parcels: Shipped -> Returned', () => {
  it('puts the stock back and records the reason', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 2 }]);
    await moveTo(orderId, ['Processing', 'Shipped']);
    expect(await stockOf(sareeId)).toBe(3);

    const res = await setStatus(orderId, { status: 'Returned', reason: 'Customer refused' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('Returned');
    expect(res.body.data.cancelReason).toBe('Customer refused');
    expect(res.body.data.restocked).toBe(true);
    expect(res.body.data.returnedAt).toBeTruthy();
    expect(await stockOf(sareeId)).toBe(5);
  });

  it('leaves stock alone when restock is false (parcel came back damaged)', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 1 }]);
    await moveTo(orderId, ['Processing', 'Shipped']);

    const res = await setStatus(orderId, { status: 'Returned', reason: 'Damaged', restock: false });

    expect(res.status).toBe(200);
    expect(res.body.data.restocked).toBe(false);
    expect(await stockOf(sareeId)).toBe(4);
  });

  it('ignores refund fields: a refused parcel was never paid for', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 1 }]);
    await moveTo(orderId, ['Processing', 'Shipped']);

    const res = await setStatus(orderId, {
      status: 'Returned',
      reason: 'Customer refused',
      refundAmount: 3060,
      refundMethod: 'bKash'
    });

    expect(res.status).toBe(200);
    expect(res.body.data.refundAmount).toBeUndefined();
  });
});

describe('No returns after delivery', () => {
  it('keeps Delivered final', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 1 }]);
    await moveTo(orderId, ['Processing', 'Shipped', 'Delivered']);

    const res = await setStatus(orderId, { status: 'Returned', reason: 'Changed mind' });

    expect(res.status).toBe(409);
    expect(await stockOf(sareeId)).toBe(4);
  });
});

describe('Return rules', () => {
  it('requires a reason', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 1 }]);
    await moveTo(orderId, ['Processing', 'Shipped']);

    const res = await setStatus(orderId, { status: 'Returned' });

    expect(res.status).toBe(400);
    expect(await stockOf(sareeId)).toBe(4);
  });

  it('cannot return an order that never shipped', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 1 }]);
    await moveTo(orderId, ['Processing']);

    const res = await setStatus(orderId, { status: 'Returned', reason: 'Customer refused' });
    expect(res.status).toBe(409);
  });

  it('Returned is final: a second return cannot restock twice', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 2 }]);
    await moveTo(orderId, ['Processing', 'Shipped']);

    const [first, second] = await Promise.all([
      setStatus(orderId, { status: 'Returned', reason: 'Customer refused' }),
      setStatus(orderId, { status: 'Returned', reason: 'Customer refused' })
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await stockOf(sareeId)).toBe(5);

    const again = await setStatus(orderId, { status: 'Delivered' });
    expect(again.status).toBe(409);
  });

  it('never adds stock for pre-order lines', async () => {
    const orderId = await placeOrder([
      { productId: sareeId, quantity: 1 },
      { productId: preorderId, quantity: 1 }
    ]);
    await moveTo(orderId, ['Processing', 'Shipped']);

    const res = await setStatus(orderId, { status: 'Returned', reason: 'Customer refused' });

    expect(res.status).toBe(200);
    expect(await stockOf(sareeId)).toBe(5);
    expect(await stockOf(preorderId)).toBe(0);
  });

  it('records an optional reason when cancelling', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 1 }]);

    const res = await setStatus(orderId, { status: 'Cancelled', reason: 'Duplicate order' });

    expect(res.status).toBe(200);
    expect(res.body.data.cancelReason).toBe('Duplicate order');
  });

  it('rejects a reason or restock flag on other transitions', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 1 }]);

    expect((await setStatus(orderId, { status: 'Processing', reason: 'x' })).status).toBe(400);
    expect((await setStatus(orderId, { status: 'Processing', restock: false })).status).toBe(400);
    expect((await setStatus(orderId, { status: 'Processing' })).status).toBe(200);
  });

  it('freezes customer details once returned', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 1 }]);
    await moveTo(orderId, ['Processing', 'Shipped']);
    await setStatus(orderId, { status: 'Returned', reason: 'Customer refused' });

    const res = await request(app)
      .patch(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ address: 'New address, Dhaka' });

    expect(res.status).toBe(409);
  });

  it('lists returned orders by status filter', async () => {
    const orderId = await placeOrder([{ productId: sareeId, quantity: 1 }]);
    await moveTo(orderId, ['Processing', 'Shipped']);
    await setStatus(orderId, { status: 'Returned', reason: 'Customer refused' });

    const res = await request(app)
      .get('/api/orders?status=Returned')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
  });
});
