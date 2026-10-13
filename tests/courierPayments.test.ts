import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';
import CourierPayment from '../src/models/CourierPayment';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

let token = '';
let productId = '';

const auth = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

// Places an order through the real checkout and walks it to the given status
async function orderWithStatus(status: 'Pending' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled' | 'Returned') {
  const res = await request(app).post('/api/orders').send({
    customerName: 'Courier Test Customer',
    phone: '01712345678',
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    items: [{ productId, quantity: 1 }]
  });
  expect(res.status).toBe(201);
  const { _id: id, orderNumber, total } = res.body.data;

  const path: Record<string, string[]> = {
    Pending: [],
    Processing: ['Processing'],
    Shipped: ['Processing', 'Shipped'],
    Delivered: ['Processing', 'Shipped', 'Delivered'],
    Cancelled: ['Cancelled'],
    Returned: ['Processing', 'Shipped', 'Returned']
  };
  for (const next of path[status]) {
    const step = await auth(request(app).patch(`/api/orders/${id}/status`)).send(
      next === 'Returned' ? { status: next, reason: 'Refused at the door' } : { status: next }
    );
    expect(step.status).toBe(200);
  }
  return { id: id as string, orderNumber: orderNumber as string, total: total as number };
}

const record = (body: object) => auth(request(app).post('/api/courier-payments')).send(body);

beforeAll(async () => {
  await Product.deleteMany({});
  const product = await Product.create({
    slug: 'courier-test-saree',
    name: 'Courier Test Saree',
    price: 1000,
    images: ['https://picsum.photos/seed/courier/800/1200'],
    category: 'Saree',
    stock: 100,
    inStock: true
  });
  productId = String(product._id);

  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  token = login.body.data.token;
});

beforeEach(async () => {
  await Order.deleteMany({});
  await CourierPayment.deleteMany({});
  await CourierPayment.syncIndexes();
});

describe('courier payments: admin only', () => {
  it.each([
    ['get', '/api/courier-payments'],
    ['get', '/api/courier-payments/unpaid'],
    ['post', '/api/courier-payments'],
    ['delete', '/api/courier-payments/000000000000000000000000']
  ] as const)('%s %s needs a token', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/courier-payments', () => {
  it('records a payout and computes every total on the server', async () => {
    const a = await orderWithStatus('Delivered');
    const b = await orderWithStatus('Delivered');

    const res = await record({
      paidAt: '2026-10-10',
      method: 'Bank transfer',
      reference: 'SF-INV-1001',
      lines: [
        { orderNumber: a.orderNumber, collected: a.total, charge: 70 },
        { orderNumber: b.orderNumber, collected: b.total, charge: 80.5 }
      ]
    });

    expect(res.status).toBe(201);
    const payment = res.body.data;
    expect(payment.courier).toBe('Steadfast');
    expect(payment.collectedTotal).toBe(a.total + b.total);
    expect(payment.chargeTotal).toBe(150.5);
    expect(payment.netTotal).toBe(a.total + b.total - 150.5);
    expect(payment.amountReceived).toBe(payment.netTotal);
    expect(payment.difference).toBe(0);
    expect(payment.recordedBy).toBe(TEST_ADMIN.email);
    expect(payment.lines[0]).toMatchObject({ orderNumber: a.orderNumber, orderTotal: a.total, net: a.total - 70 });
  });

  it('keeps the difference when less money arrived than the statement says', async () => {
    const a = await orderWithStatus('Delivered');
    const res = await record({
      paidAt: '2026-10-10',
      amountReceived: 900,
      lines: [{ orderNumber: a.orderNumber, collected: a.total, charge: 60 }]
    });
    expect(res.status).toBe(201);
    expect(res.body.data.difference).toBe(900 - (a.total - 60));
  });

  it.each(['Returned', 'Shipped'] as const)('accepts a refused parcel marked %s with only a return charge', async (status) => {
    const returned = await orderWithStatus(status);
    const res = await record({
      paidAt: '2026-10-10',
      lines: [{ orderNumber: returned.orderNumber, collected: 0, charge: 50 }]
    });
    expect(res.status).toBe(201);
    expect(res.body.data.netTotal).toBe(-50);
  });

  it('refuses orders the courier never had', async () => {
    const pending = await orderWithStatus('Pending');
    const cancelled = await orderWithStatus('Cancelled');
    const res = await record({
      paidAt: '2026-10-10',
      lines: [
        { orderNumber: pending.orderNumber, collected: 1000, charge: 60 },
        { orderNumber: cancelled.orderNumber, collected: 1000, charge: 60 }
      ]
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain(`${pending.orderNumber} is Pending`);
    expect(res.body.message).toContain(`${cancelled.orderNumber} is Cancelled`);
  });

  it('refuses an unknown order number', async () => {
    const res = await record({ paidAt: '2026-10-10', lines: [{ orderNumber: 'ORD-NOPE', collected: 1, charge: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('ORD-NOPE');
  });

  it('refuses an order already paid for, and the same order twice in one payment', async () => {
    const a = await orderWithStatus('Delivered');
    const line = { orderNumber: a.orderNumber, collected: a.total, charge: 60 };

    const twice = await record({ paidAt: '2026-10-10', lines: [line, line] });
    expect(twice.status).toBe(400);

    expect((await record({ paidAt: '2026-10-10', lines: [line] })).status).toBe(201);
    const again = await record({ paidAt: '2026-10-11', lines: [line] });
    expect(again.status).toBe(409);
    expect(again.body.message).toContain(a.orderNumber);
  });

  it('lets only one of two simultaneous payments claim the same order', async () => {
    const a = await orderWithStatus('Delivered');
    const body = { paidAt: '2026-10-10', lines: [{ orderNumber: a.orderNumber, collected: a.total, charge: 60 }] };
    const results = await Promise.all([record(body), record(body), record(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await CourierPayment.countDocuments()).toBe(1);
  });

  it('rejects bad input', async () => {
    const a = await orderWithStatus('Delivered');
    const line = { orderNumber: a.orderNumber, collected: a.total, charge: 60 };
    const cases = [
      { lines: [line] },
      { paidAt: 'not a date', lines: [line] },
      { paidAt: '2999-01-01', lines: [line] },
      { paidAt: '2026-10-10', lines: [] },
      { paidAt: '2026-10-10', lines: [{ ...line, charge: -1 }] },
      { paidAt: '2026-10-10', lines: [line], method: 'Cheque' },
      { paidAt: '2026-10-10', lines: [line], netTotal: 1 }
    ];
    for (const body of cases) {
      const res = await record(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await CourierPayment.countDocuments()).toBe(0);
  });
});

describe('GET /api/courier-payments/unpaid', () => {
  it('lists delivered orders no payment covers, with the cash expected', async () => {
    const paid = await orderWithStatus('Delivered');
    const unpaid1 = await orderWithStatus('Delivered');
    const unpaid2 = await orderWithStatus('Delivered');
    await orderWithStatus('Shipped');
    await orderWithStatus('Returned');
    await orderWithStatus('Pending');

    await record({ paidAt: '2026-10-10', lines: [{ orderNumber: paid.orderNumber, collected: paid.total, charge: 60 }] });

    const res = await auth(request(app).get('/api/courier-payments/unpaid'));
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
    expect(res.body.data.expectedTotal).toBe(unpaid1.total + unpaid2.total);
    expect(res.body.data.orders.map((o: any) => o.orderNumber).sort()).toEqual(
      [unpaid1.orderNumber, unpaid2.orderNumber].sort()
    );
  });
});

describe('GET and DELETE /api/courier-payments', () => {
  it('lists payments newest first with all-time totals', async () => {
    const a = await orderWithStatus('Delivered');
    const b = await orderWithStatus('Delivered');
    await record({ paidAt: '2026-10-01', lines: [{ orderNumber: a.orderNumber, collected: 1000, charge: 60 }] });
    await record({ paidAt: '2026-10-08', amountReceived: 930, lines: [{ orderNumber: b.orderNumber, collected: 1000, charge: 60 }] });

    const res = await auth(request(app).get('/api/courier-payments'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].lines[0].orderNumber).toBe(b.orderNumber);
    expect(res.body.summary).toEqual({ collectedTotal: 2000, chargeTotal: 120, netTotal: 1880, amountReceived: 1870 });
    expect(res.body.pagination).toMatchObject({ page: 1, total: 2, pages: 1 });

    const one = await auth(request(app).get(`/api/courier-payments/${res.body.data[1]._id}`));
    expect(one.status).toBe(200);
    expect(one.body.data.lines[0].orderNumber).toBe(a.orderNumber);
  });

  it('deleting a mistaken payment makes its orders unpaid again', async () => {
    const a = await orderWithStatus('Delivered');
    const created = await record({ paidAt: '2026-10-10', lines: [{ orderNumber: a.orderNumber, collected: 1, charge: 0 }] });

    const del = await auth(request(app).delete(`/api/courier-payments/${created.body.data._id}`));
    expect(del.status).toBe(200);

    const unpaid = await auth(request(app).get('/api/courier-payments/unpaid'));
    expect(unpaid.body.data.count).toBe(1);

    const again = await auth(request(app).delete(`/api/courier-payments/${created.body.data._id}`));
    expect(again.status).toBe(404);
    expect((await auth(request(app).get('/api/courier-payments/not-an-id'))).status).toBe(400);
  });
});
