import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Order from '../src/models/Order';

const OWNER = { email: 'testadmin@coovi.com', password: 'testpass123' };
let token = '';

const list = (query: string) =>
  request(app).get(`/api/orders?${query}`).set('Authorization', `Bearer ${token}`);
const numbers = (res: request.Response): string[] => res.body.data.map((o: { orderNumber: string }) => o.orderNumber).sort();

const order = (orderNumber: string, extra: Record<string, unknown>) => ({
  orderNumber,
  customerName: 'Rina Akter',
  phone: '01711111111',
  address: 'House 1, Road 2, Dhaka',
  items: [{ productId: '507f1f77bcf86cd799439011', name: 'Saree', price: 1000, quantity: 1, image: 'https://x.test/a.jpg' }],
  subtotal: 1000,
  deliveryFee: 70,
  total: 1070,
  status: 'Pending',
  source: 'website',
  internalNotes: [],
  statusHistory: [],
  editHistory: [],
  createdAt: new Date('2026-10-10T06:00:00Z'),
  updatedAt: new Date('2026-10-10T06:00:00Z'),
  ...extra
});

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send(OWNER);
  token = login.body.data.token;

  await Order.deleteMany({});
  // Raw inserts so createdAt can be set to any day
  await Order.collection.insertMany([
    order('ORD-20261010-AAAAAA', {}),
    order('ORD-20261011-BBBBBB', { customerName: 'Karim (Uddin)', phone: '01822222222', source: 'facebook', createdAt: new Date('2026-10-11T06:00:00Z') }),
    // 23:30 on 12 October in Dhaka, still 12 October there although UTC says 17:30
    order('ORD-20261012-CCCCCC', { phone: '01933333333', status: 'Delivered', createdAt: new Date('2026-10-12T17:30:00Z') }),
    // Placed before manual entry existed: no source at all
    order('ORD-20260901-DDDDDD', { source: undefined, createdAt: new Date('2026-09-01T06:00:00Z') })
  ]);
  await Order.collection.updateOne({ orderNumber: 'ORD-20260901-DDDDDD' }, { $unset: { source: 1 } });
});

describe('GET /api/orders filters', () => {
  it('searches order number, name and phone, partly and in any case', async () => {
    expect(numbers(await list('search=bbbbbb'))).toEqual(['ORD-20261011-BBBBBB']);
    expect(numbers(await list('search=rina'))).toEqual(['ORD-20260901-DDDDDD', 'ORD-20261010-AAAAAA', 'ORD-20261012-CCCCCC']);
    expect(numbers(await list('search=01933'))).toEqual(['ORD-20261012-CCCCCC']);
  });

  it('treats search text literally', async () => {
    const res = await list(`search=${encodeURIComponent('(Uddin)')}`);
    expect(res.status).toBe(200);
    expect(numbers(res)).toEqual(['ORD-20261011-BBBBBB']);
    expect((await list(`search=${encodeURIComponent('.*')}`)).body.data).toHaveLength(0);
  });

  it('filters by Bangladesh days, both ends included', async () => {
    expect(numbers(await list('from=2026-10-11&to=2026-10-12'))).toEqual(['ORD-20261011-BBBBBB', 'ORD-20261012-CCCCCC']);
    expect(numbers(await list('from=2026-10-13'))).toEqual([]);
    expect(numbers(await list('to=2026-10-10'))).toEqual(['ORD-20260901-DDDDDD', 'ORD-20261010-AAAAAA']);
  });

  it('filters by source, counting orders without one as website', async () => {
    expect(numbers(await list('source=facebook'))).toEqual(['ORD-20261011-BBBBBB']);
    expect(numbers(await list('source=website'))).toEqual(['ORD-20260901-DDDDDD', 'ORD-20261010-AAAAAA', 'ORD-20261012-CCCCCC']);
  });

  it('combines filters and counts the matches for paging', async () => {
    const res = await list('search=rina&status=Pending&limit=1');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ total: 2, pages: 2 });
  });

  it('ignores bad filter values instead of failing', async () => {
    const res = await list('from=2026-02-30&to=yesterday&source=fax');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(4);
  });
});
