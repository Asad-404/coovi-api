import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';
import { PRIVATE_ORDER_FIELDS } from '../src/routes/orders';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };
const PHONE = '01712345678';

let token = '';
let productId = '';

async function placeOrder(quantity = 1) {
  const res = await request(app).post('/api/orders').send({
    customerName: 'History Test Customer',
    phone: PHONE,
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    items: [{ productId, quantity }]
  });
  expect(res.status).toBe(201);
  return res.body.data as { _id: string; orderNumber: string } & Record<string, unknown>;
}

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const addNote = (orderId: string, body: object) => auth(request(app).post(`/api/orders/${orderId}/notes`)).send(body);
const setStatus = (orderId: string, status: string) =>
  auth(request(app).patch(`/api/orders/${orderId}/status`)).send({ status });

beforeAll(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const product = await Product.create({
    slug: 'history-test-saree',
    name: 'History Test Saree',
    price: 1000,
    images: ['https://picsum.photos/seed/history/800/1200'],
    category: 'Saree',
    stock: 5,
    inStock: true
  });
  productId = String(product._id);
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  token = login.body.data.token;
});

describe('POST /api/orders/:id/notes', () => {
  it('adds a note stamped with the admin who wrote it', async () => {
    const { _id } = await placeOrder();
    const res = await addNote(_id, { text: '  Called, will pay on Friday  ' });

    expect(res.status).toBe(201);
    expect(res.body.data.internalNotes).toHaveLength(1);
    expect(res.body.data.internalNotes[0]).toMatchObject({ text: 'Called, will pay on Friday', by: TEST_ADMIN.email });
    expect(res.body.data.internalNotes[0].byId).toBeTruthy();
    expect(res.body.data.internalNotes[0].at).toBeTruthy();

    await addNote(_id, { text: 'Second call, confirmed' });
    expect((await Order.findById(_id))?.internalNotes.map((n) => n.text)).toEqual([
      'Called, will pay on Friday',
      'Second call, confirmed'
    ]);
  });

  it('rejects an empty, blank or oversized note', async () => {
    const { _id } = await placeOrder();
    for (const text of ['', '   ', 'x'.repeat(501)]) {
      expect((await addNote(_id, { text })).status).toBe(400);
    }
    expect((await addNote(_id, {})).status).toBe(400);
    expect((await Order.findById(_id))?.internalNotes).toHaveLength(0);
  });

  it('works on a delivered order', async () => {
    const { _id } = await placeOrder();
    for (const status of ['Processing', 'Shipped', 'Delivered']) await setStatus(_id, status);
    await Product.updateOne({ _id: productId }, { $set: { stock: 5 } });
    expect((await addNote(_id, { text: 'Customer asked about a return' })).status).toBe(201);
  });

  it('needs an admin token, and 404s or 400s for a bad order id', async () => {
    const { _id } = await placeOrder();
    expect((await request(app).post(`/api/orders/${_id}/notes`).send({ text: 'hi' })).status).toBe(401);
    expect((await addNote('6650f1f1f1f1f1f1f1f1f1f1', { text: 'hi' })).status).toBe(404);
    expect((await addNote('not-an-id', { text: 'hi' })).status).toBe(400);
  });
});

describe('status history', () => {
  it('records the customer placing the order, then every admin transition', async () => {
    const { _id } = await placeOrder();
    for (const status of ['Processing', 'Shipped', 'Delivered']) {
      expect((await setStatus(_id, status)).status).toBe(200);
    }
    await Product.updateOne({ _id: productId }, { $set: { stock: 5 } });

    const history = (await Order.findById(_id))!.statusHistory;
    expect(history.map((h) => [h.from, h.to, h.by])).toEqual([
      [undefined, 'Pending', 'customer'],
      ['Pending', 'Processing', TEST_ADMIN.email],
      ['Processing', 'Shipped', TEST_ADMIN.email],
      ['Shipped', 'Delivered', TEST_ADMIN.email]
    ]);
    expect(history[1].byId).toBeTruthy();
  });

  it('writes no entry for a refused transition', async () => {
    const { _id } = await placeOrder();
    expect((await setStatus(_id, 'Delivered')).status).toBe(409);
    expect((await Order.findById(_id))!.statusHistory).toHaveLength(1);
  });

  it('removes the entry again when confirming fails for lack of stock', async () => {
    await Product.updateOne({ _id: productId }, { $set: { stock: 5 } });
    const { _id } = await placeOrder(3);
    await Product.updateOne({ _id: productId }, { $set: { stock: 1 } });

    expect((await setStatus(_id, 'Processing')).status).toBe(409);
    const order = (await Order.findById(_id))!;
    expect(order.status).toBe('Pending');
    expect(order.statusHistory.map((h) => h.to)).toEqual(['Pending']);
    await Product.updateOne({ _id: productId }, { $set: { stock: 5 } });
  });
});

describe('detail edit history', () => {
  it('records who changed which field, from what to what', async () => {
    const { _id } = await placeOrder();
    const res = await auth(request(app).patch(`/api/orders/${_id}`)).send({
      phone: '01811111111',
      customerName: 'History Test Customer',
      notes: 'Ring the bell twice'
    });

    expect(res.status).toBe(200);
    expect(res.body.data.editHistory).toHaveLength(1);
    expect(res.body.data.editHistory[0]).toMatchObject({
      by: TEST_ADMIN.email,
      // The unchanged name is left out
      changes: [
        { field: 'phone', from: PHONE, to: '01811111111' },
        { field: 'notes', to: 'Ring the bell twice' }
      ]
    });
  });

  it('writes no entry when nothing actually changes', async () => {
    const { _id } = await placeOrder();
    const res = await auth(request(app).patch(`/api/orders/${_id}`)).send({ phone: PHONE });
    expect(res.status).toBe(200);
    expect(res.body.data.editHistory).toHaveLength(0);
  });
});

describe('customers never see private fields', () => {
  it('leaves them out of the order confirmation and the public tracking response', async () => {
    const placed = await placeOrder();
    await addNote(placed._id, { text: 'Seems like a fake order' });
    await auth(request(app).patch(`/api/orders/${placed._id}`)).send({ address: 'House 1, Road 1, Mirpur, Dhaka' });

    const tracked = await request(app).get(`/api/orders/${placed.orderNumber}`).query({ phone: PHONE });
    expect(tracked.status).toBe(200);

    for (const field of PRIVATE_ORDER_FIELDS) {
      expect(placed).not.toHaveProperty(field);
      expect(tracked.body.data).not.toHaveProperty(field);
    }
    expect(JSON.stringify(tracked.body)).not.toContain('fake order');
    expect(placed).not.toHaveProperty('__v');
    expect(tracked.body.data.orderNumber).toBe(placed.orderNumber);
  });

  it('admins get them in the order list', async () => {
    const res = await auth(request(app).get('/api/orders'));
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toHaveProperty('internalNotes');
    expect(res.body.data[0]).toHaveProperty('statusHistory');
  });
});
