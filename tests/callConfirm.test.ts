import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { MAX_PENDING_PER_PHONE, pendingPerPhoneCheck } from '../src/routes/orders';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

// Off by default in tests; this file checks it
pendingPerPhoneCheck.enabled = true;

let sareeId = '';
let token = '';

beforeEach(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const [saree] = await Product.create([
    {
      slug: 'call-confirm-saree',
      name: 'Call Confirm Saree',
      price: 1000,
      images: ['https://picsum.photos/seed/callconfirm/800/1200'],
      stock: 20
    }
  ]);
  sareeId = String(saree._id);
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  token = login.body.data.token as string;
});

const checkout = (phone = '01712345678') =>
  request(app)
    .post('/api/orders')
    .send({
      customerName: 'Website Customer',
      phone,
      address: 'House 12, Road 5, Dhanmondi, Dhaka',
      items: [{ productId: sareeId, quantity: 1 }]
    });

const setConfirmed = (id: string, body: unknown) =>
  request(app).patch(`/api/orders/${id}/call-confirmed`).set('Authorization', `Bearer ${token}`).send(body);

describe('Unconfirmed orders per phone', () => {
  it(`refuses a website order when the phone already has ${MAX_PENDING_PER_PHONE} Pending ones`, async () => {
    for (let i = 0; i < MAX_PENDING_PER_PHONE; i++) {
      expect((await checkout()).status).toBe(201);
    }
    const res = await checkout();
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/waiting for our confirmation call/);

    // Another phone is not affected
    expect((await checkout('01812345678')).status).toBe(201);
  });

  it('counts only Pending website orders', async () => {
    for (let i = 0; i < MAX_PENDING_PER_PHONE; i++) await checkout();
    const one = await Order.findOne({ phone: '01712345678' });
    await Order.updateOne({ _id: one!._id }, { status: 'Cancelled' });
    expect((await checkout()).status).toBe(201);

    // Manual orders an admin entered don't use up the customer's allowance
    await Order.updateMany({ phone: '01712345678', status: 'Pending' }, { source: 'phone' });
    expect((await checkout()).status).toBe(201);
  });
});

describe('PATCH /api/orders/:id/call-confirmed', () => {
  it('marks, records and removes the call confirmation', async () => {
    const placed = await checkout();
    expect(placed.body.data.callConfirmed).toBeUndefined();
    const id = placed.body.data._id as string;

    const on = await setConfirmed(id, { confirmed: true });
    expect(on.status).toBe(200);
    expect(on.body.data.callConfirmed.by).toBe(TEST_ADMIN.email);
    expect(on.body.data.callConfirmed.at).toBeTruthy();
    expect(on.body.data.editHistory.at(-1).changes).toEqual([{ field: 'callConfirmed', from: 'no', to: 'yes' }]);

    // Sending the same value again changes nothing
    const again = await setConfirmed(id, { confirmed: true });
    expect(again.status).toBe(200);
    expect(again.body.data.editHistory).toHaveLength(1);

    const off = await setConfirmed(id, { confirmed: false });
    expect(off.status).toBe(200);
    expect(off.body.data.callConfirmed).toBeUndefined();
    expect(off.body.data.editHistory.at(-1).changes).toEqual([{ field: 'callConfirmed', from: 'yes', to: 'no' }]);
  });

  it('keeps the confirmation out of the public order lookup', async () => {
    const placed = await checkout();
    await setConfirmed(placed.body.data._id, { confirmed: true });
    const res = await request(app).get(`/api/orders/${placed.body.data.orderNumber}?phone=01712345678`);
    expect(res.status).toBe(200);
    expect(res.body.data.callConfirmed).toBeUndefined();
  });

  it('rejects a bad body, a missing order, final orders and signed-out callers', async () => {
    const placed = await checkout();
    const id = placed.body.data._id as string;

    expect((await setConfirmed(id, {})).status).toBe(400);
    expect((await setConfirmed(id, { confirmed: 'yes' })).status).toBe(400);
    expect((await setConfirmed('64b7f0000000000000000000', { confirmed: true })).status).toBe(404);

    await Order.updateOne({ _id: id }, { status: 'Cancelled' });
    expect((await setConfirmed(id, { confirmed: true })).status).toBe(409);

    const anon = await request(app).patch(`/api/orders/${id}/call-confirmed`).send({ confirmed: true });
    expect(anon.status).toBe(401);
  });

  it('treats a manual order as already confirmed by the admin who entered it', async () => {
    const res = await request(app)
      .post('/api/orders/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerName: 'Facebook Customer',
        phone: '01912345678',
        address: 'House 3, Road 2, Mirpur, Dhaka',
        source: 'facebook',
        items: [{ productId: sareeId, quantity: 1 }]
      });
    expect(res.status).toBe(201);
    expect(res.body.data.callConfirmed.by).toBe(TEST_ADMIN.email);
  });
});
