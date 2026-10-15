import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../src/app';
import Admin from '../src/models/Admin';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

const OWNER = { email: 'testadmin@coovi.com', password: 'testpass123' };

const tokenFor = async (email: string, password: string): Promise<string> => {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data.token as string;
};

let ownerToken = '';
let staffToken = '';
let costedId = '';
let plainId = '';

const asOwner = (req: request.Test) => req.set('Authorization', `Bearer ${ownerToken}`);
const asStaff = (req: request.Test) => req.set('Authorization', `Bearer ${staffToken}`);

const productBody = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: slug,
  price: 1000,
  images: ['https://picsum.photos/seed/stats/800/1200'],
  stock: 50,
  ...extra
});

async function placeOrder(productId: string, quantity = 1) {
  const res = await request(app).post('/api/orders').send({
    customerName: 'Stats Customer',
    phone: '01712345678',
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    district: 'Dhaka',
    deliveryArea: 'inside_dhaka',
    items: [{ productId, quantity }]
  });
  expect(res.status).toBe(201);
  return res.body.data as { _id: string; total: number; deliveryFee: number; items: Record<string, unknown>[] };
}

async function moveTo(id: string, steps: string[]) {
  for (const status of steps) {
    const res = await asOwner(request(app).patch(`/api/orders/${id}/status`)).send(
      status === 'Returned' ? { status, reason: 'Refused at the door' } : { status }
    );
    expect(res.status).toBe(200);
  }
}

beforeAll(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  ownerToken = await tokenFor(OWNER.email, OWNER.password);

  await Admin.create({
    email: 'stats-staff@coovi.com',
    passwordHash: await bcrypt.hash('staff-pass-123', 10),
    role: 'staff',
    permissions: ['orders.view', 'orders.edit', 'products.view', 'products.edit']
  });
  staffToken = await tokenFor('stats-staff@coovi.com', 'staff-pass-123');

  const costed = await asOwner(request(app).post('/api/products')).send(productBody('costed-saree', { costPrice: 600 }));
  expect(costed.status).toBe(201);
  costedId = costed.body.data._id;
  const plain = await asOwner(request(app).post('/api/products')).send(productBody('plain-saree'));
  expect(plain.status).toBe(201);
  plainId = plain.body.data._id;
});

describe('product cost price', () => {
  it('never appears in public product responses', async () => {
    const list = await request(app).get('/api/products');
    expect(list.status).toBe(200);
    for (const product of list.body.data) expect(product.costPrice).toBeUndefined();

    const one = await request(app).get('/api/products/costed-saree');
    expect(one.body.data.costPrice).toBeUndefined();
  });

  it('is read through its own route with money access', async () => {
    const res = await asOwner(request(app).get(`/api/products/${costedId}/cost`));
    expect(res.status).toBe(200);
    expect(res.body.data.costPrice).toBe(600);

    const none = await asOwner(request(app).get(`/api/products/${plainId}/cost`));
    expect(none.body.data.costPrice).toBeNull();

    const staff = await asStaff(request(app).get(`/api/products/${costedId}/cost`));
    expect(staff.status).toBe(403);
  });

  it('is kept when an update leaves it out, and removed with null', async () => {
    const keep = await asStaff(request(app).put(`/api/products/${costedId}`)).send(productBody('costed-saree', { name: 'Renamed' }));
    expect(keep.status).toBe(200);
    expect(keep.body.data.costPrice).toBeUndefined();
    expect((await Product.findById(costedId).select('+costPrice').lean())?.costPrice).toBe(600);

    const tmp = await asOwner(request(app).post('/api/products')).send(productBody('tmp-saree', { costPrice: 100 }));
    const cleared = await asOwner(request(app).put(`/api/products/${tmp.body.data._id}`)).send(productBody('tmp-saree', { costPrice: null }));
    expect(cleared.status).toBe(200);
    expect((await Product.findById(tmp.body.data._id).select('+costPrice').lean())?.costPrice).toBeUndefined();
    await Product.deleteOne({ _id: tmp.body.data._id });
  });

  it('cannot be set without money access', async () => {
    const create = await asStaff(request(app).post('/api/products')).send(productBody('staff-saree', { costPrice: 1 }));
    expect(create.status).toBe(403);
    const update = await asStaff(request(app).put(`/api/products/${costedId}`)).send(productBody('costed-saree', { costPrice: 1 }));
    expect(update.status).toBe(403);
    expect((await Product.findById(costedId).select('+costPrice').lean())?.costPrice).toBe(600);
  });

  it('is copied onto the order but never sent back', async () => {
    const order = await placeOrder(costedId);
    for (const item of order.items) expect(item.costPrice).toBeUndefined();

    const saved = await Order.findById(order._id).select('+items.costPrice').lean();
    expect(saved?.items[0].costPrice).toBe(600);

    const list = await asOwner(request(app).get('/api/orders'));
    for (const o of list.body.data) for (const item of o.items) expect(item.costPrice).toBeUndefined();

    await Order.deleteOne({ _id: order._id });
  });
});

describe('GET /api/stats', () => {
  beforeAll(async () => {
    await Order.deleteMany({});
    // Delivered with a known cost: profit = 3 x (1000 - 600) = 1200
    const a = await placeOrder(costedId, 3);
    await moveTo(a._id, ['Processing', 'Shipped', 'Delivered']);
    // Delivered without a cost: counted as unknown
    const b = await placeOrder(plainId);
    await moveTo(b._id, ['Processing', 'Shipped', 'Delivered']);
    // Refused at the door
    const c = await placeOrder(plainId);
    await moveTo(c._id, ['Processing', 'Shipped', 'Returned']);
    // Still waiting
    await placeOrder(plainId);
    const e = await placeOrder(costedId);
    await moveTo(e._id, ['Cancelled']);
  });

  it('needs order access', async () => {
    expect((await request(app).get('/api/stats')).status).toBe(401);
  });

  it('gives the owner order counts and money', async () => {
    const res = await asOwner(request(app).get('/api/stats'));
    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.range.days).toBe(30);
    expect(data.orders.total).toBe(5);
    expect(data.orders.byStatus).toMatchObject({ Pending: 1, Delivered: 2, Returned: 1, Cancelled: 1 });
    expect(data.orders.bySource.website).toBe(5);
    expect(data.orders.refusedRate).toBe(33.33);
    expect(data.pipeline).toMatchObject({ toConfirm: 1, toShip: 0, onTheWay: 0 });
    expect(data.topDistricts[0]).toEqual({ district: 'Dhaka', orders: 5 });
    expect(data.daily).toHaveLength(30);
    expect(data.daily.at(-1).orders).toBe(5);

    const fee = (await Order.findOne().lean())!.deliveryFee;
    expect(data.money).toMatchObject({
      deliveredRevenue: 4000 + 2 * fee,
      deliveredOrders: 2,
      orderValue: 5000 + 3 * fee,
      deliveryFees: 2 * fee,
      cost: 1800,
      grossProfit: 1200,
      profitOrders: 1,
      unknownCostOrders: 1,
      courierOwes: { orders: 2, total: 4000 + 2 * fee }
    });
    expect(data.bestSellers[0]).toMatchObject({ productId: costedId, quantity: 3, value: 3000 });
  });

  it('leaves money out for people without money access', async () => {
    const res = await asStaff(request(app).get('/api/stats'));
    expect(res.status).toBe(200);
    expect(res.body.data.money).toBeUndefined();
    expect(res.body.data.orders.total).toBe(5);
    expect(res.body.data.daily[0].value).toBeUndefined();
    expect(res.body.data.bestSellers[0].value).toBeUndefined();
  });

  it('counts only orders placed in the range', async () => {
    const res = await asOwner(request(app).get('/api/stats?from=2020-01-01&to=2020-01-31'));
    expect(res.status).toBe(200);
    expect(res.body.data.orders.total).toBe(0);
    expect(res.body.data.daily).toHaveLength(31);
    // The courier still owes for delivered orders from any date
    expect(res.body.data.money.courierOwes.orders).toBe(2);
  });

  it('rejects a bad range', async () => {
    for (const query of ['from=2026-13-01', 'from=yesterday', 'from=2026-10-15&to=2026-10-01', 'from=2024-01-01&to=2026-01-01']) {
      const res = await asOwner(request(app).get(`/api/stats?${query}`));
      expect(res.status).toBe(400);
    }
  });
});
