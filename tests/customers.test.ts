import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../src/app';
import Admin from '../src/models/Admin';
import Order from '../src/models/Order';
import BlockedPhone from '../src/models/BlockedPhone';

const OWNER = { email: 'testadmin@coovi.com', password: 'testpass123' };
let ownerToken = '';
let viewerToken = '';

const asOwner = (req: request.Test) => req.set('Authorization', `Bearer ${ownerToken}`);
const asViewer = (req: request.Test) => req.set('Authorization', `Bearer ${viewerToken}`);

const RINA = '01711111111';
const KARIM = '01822222222';

let n = 0;
const order = (phone: string, customerName: string, status: string, total: number, day: string) => ({
  orderNumber: `ORD-TEST-${++n}`,
  customerName,
  phone,
  address: `House ${n}, Dhaka`,
  items: [{ productId: '507f1f77bcf86cd799439011', name: 'Saree', price: total - 70, quantity: 1, image: 'https://x.test/a.jpg' }],
  subtotal: total - 70,
  deliveryFee: 70,
  total,
  status,
  source: 'website',
  internalNotes: [],
  statusHistory: [],
  editHistory: [],
  createdAt: new Date(`${day}T06:00:00Z`),
  updatedAt: new Date(`${day}T06:00:00Z`)
});

beforeAll(async () => {
  ownerToken = (await request(app).post('/api/auth/login').send(OWNER)).body.data.token;
  await Admin.create({
    email: 'customers-viewer@coovi.com',
    passwordHash: await bcrypt.hash('viewer-pass-123', 10),
    role: 'viewer',
    permissions: ['orders.view', 'products.view']
  });
  viewerToken = (await request(app).post('/api/auth/login').send({ email: 'customers-viewer@coovi.com', password: 'viewer-pass-123' })).body.data.token;

  await Order.deleteMany({});
  await BlockedPhone.deleteMany({});
  await Order.collection.insertMany([
    order(RINA, 'Rina', 'Delivered', 1070, '2026-10-01'),
    order(RINA, 'Rina Akter', 'Delivered', 2070, '2026-10-05'),
    order(KARIM, 'Karim', 'Returned', 1570, '2026-10-02'),
    order(KARIM, 'Karim', 'Cancelled', 1570, '2026-10-03'),
    order(KARIM, 'Karim Uddin', 'Pending', 1570, '2026-10-04')
  ]);
});

describe('GET /api/customers', () => {
  it('adds up each phone, with the newest name', async () => {
    const res = await asOwner(request(app).get('/api/customers'));
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(2);
    // Most recent order first
    const [rina, karim] = res.body.data;
    expect(rina).toMatchObject({ phone: RINA, name: 'Rina Akter', orders: 2, delivered: 2, spent: 3140, risky: false, blocked: null });
    expect(karim).toMatchObject({ phone: KARIM, name: 'Karim Uddin', orders: 3, delivered: 0, returned: 1, cancelled: 1, spent: 0, risky: true });
  });

  it('sorts by most refused and cancelled', async () => {
    const res = await asOwner(request(app).get('/api/customers?sort=refused'));
    expect(res.body.data[0].phone).toBe(KARIM);
  });

  it('searches phone and name', async () => {
    expect((await asOwner(request(app).get('/api/customers?search=0182'))).body.data.map((c: { phone: string }) => c.phone)).toEqual([KARIM]);
    expect((await asOwner(request(app).get('/api/customers?search=akter'))).body.data.map((c: { phone: string }) => c.phone)).toEqual([RINA]);
  });

  it('leaves money out without money access', async () => {
    const res = await asViewer(request(app).get('/api/customers'));
    expect(res.status).toBe(200);
    expect(res.body.data[0].spent).toBeUndefined();
  });

  it('needs an admin login', async () => {
    expect((await request(app).get('/api/customers')).status).toBe(401);
  });
});

describe('blocking a phone', () => {
  it('needs orders.edit', async () => {
    const res = await asViewer(request(app).put(`/api/customers/${KARIM}/block`)).send({ blocked: true });
    expect(res.status).toBe(403);
  });

  it('rejects a bad phone or body', async () => {
    expect((await asOwner(request(app).put('/api/customers/12345/block')).send({ blocked: true })).status).toBe(400);
    expect((await asOwner(request(app).put(`/api/customers/${KARIM}/block`)).send({ blocked: 'yes' })).status).toBe(400);
  });

  it('marks the phone, shows it on its orders and lists it', async () => {
    const res = await asOwner(request(app).put(`/api/customers/${KARIM}/block`)).send({ blocked: true, note: 'Refused twice' });
    expect(res.status).toBe(200);
    expect(res.body.data.blocked).toMatchObject({ note: 'Refused twice', by: OWNER.email });

    const orders = await asOwner(request(app).get('/api/orders'));
    for (const o of orders.body.data) {
      if (o.phone === KARIM) expect(o.blockedPhone).toMatchObject({ note: 'Refused twice' });
      else expect(o.blockedPhone).toBeUndefined();
    }

    const blocked = await asOwner(request(app).get('/api/customers?blocked=true'));
    expect(blocked.body.data.map((c: { phone: string }) => c.phone)).toEqual([KARIM]);
  });

  it('still accepts orders from a blocked phone', async () => {
    const product = await (await import('../src/models/Product')).default.create({
      slug: 'blocked-test-saree', name: 'Blocked Test Saree', price: 1000,
      images: ['https://x.test/b.jpg'], category: 'Saree', stock: 5, inStock: true
    });
    const res = await request(app).post('/api/orders').send({
      customerName: 'Karim', phone: KARIM, address: 'House 9, Road 9, Dhaka', items: [{ productId: String(product._id), quantity: 1 }]
    });
    expect(res.status).toBe(201);
    // The customer is never told about the block
    expect(res.body.data.blockedPhone).toBeUndefined();
  });

  it('shows the phone with its orders', async () => {
    const res = await asOwner(request(app).get(`/api/customers/${KARIM}`));
    expect(res.status).toBe(200);
    expect(res.body.data.customer).toMatchObject({ phone: KARIM, orders: 4, blocked: { note: 'Refused twice' } });
    expect(res.body.data.orders).toHaveLength(4);
  });

  it('unblocks', async () => {
    const res = await asOwner(request(app).put(`/api/customers/${KARIM}/block`)).send({ blocked: false });
    expect(res.status).toBe(200);
    expect(await BlockedPhone.countDocuments()).toBe(0);
    const one = await asOwner(request(app).get(`/api/customers/${KARIM}`));
    expect(one.body.data.customer.blocked).toBeNull();
  });

  it('can block a phone that has never ordered', async () => {
    const fresh = '01999999999';
    await asOwner(request(app).put(`/api/customers/${fresh}/block`)).send({ blocked: true });
    const res = await asOwner(request(app).get(`/api/customers/${fresh}`));
    expect(res.status).toBe(200);
    expect(res.body.data.customer).toMatchObject({ orders: 0, blocked: { by: OWNER.email } });
    expect((await asOwner(request(app).get('/api/customers/01888888888'))).status).toBe(404);
  });
});
