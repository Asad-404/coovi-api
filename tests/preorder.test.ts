import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

async function getAdminToken(): Promise<string> {
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  return login.body.data.token as string;
}

function placeOrder(items: { productId: string; quantity: number }[]) {
  return request(app).post('/api/orders').send({
    customerName: 'Preorder Test Customer',
    phone: '01712345678',
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    items
  });
}

async function setStatus(token: string, orderId: string, status: string) {
  return request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status });
}

let preorderId = '';
let plainId = '';

beforeEach(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const created = await Product.create([
    {
      slug: 'preorder-test-katan',
      name: 'Katan Preorder Saree',
      price: 5000,
      images: ['https://picsum.photos/seed/preorder/800/1200'],
      stock: 1,
      allowPreorder: true,
      preorderDays: 20
    },
    {
      slug: 'preorder-test-cotton',
      name: 'Cotton Plain Saree',
      price: 1200,
      images: ['https://picsum.photos/seed/plain/800/1200'],
      stock: 1
    }
  ]);
  preorderId = String(created[0]._id);
  plainId = String(created[1]._id);
});

describe('Pre-orders on POST /api/orders', () => {
  it('sells from stock as a normal line while enough stock exists', async () => {
    const res = await placeOrder([{ productId: preorderId, quantity: 1 }]);

    expect(res.status).toBe(201);
    expect(res.body.data.items[0].preorder).toBe(false);
    expect(res.body.data.items[0].preorderDays).toBeUndefined();
  });

  it('takes the line as a pre-order when stock is short and the product allows it', async () => {
    await Product.updateOne({ _id: preorderId }, { $set: { stock: 0 } });

    const res = await placeOrder([{ productId: preorderId, quantity: 2 }]);

    expect(res.status).toBe(201);
    expect(res.body.data.items[0].preorder).toBe(true);
    expect(res.body.data.items[0].preorderDays).toBe(20);
    expect(res.body.data.total).toBe(2 * 5000 + res.body.data.deliveryFee);
  });

  it('still refuses a product without pre-orders when stock is short', async () => {
    const res = await placeOrder([{ productId: plainId, quantity: 2 }]);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Only 1 left');
  });

  it('still refuses a pre-order product that is switched off for sale', async () => {
    await Product.updateOne({ _id: preorderId }, { $set: { stock: 0, inStock: false } });

    const res = await placeOrder([{ productId: preorderId, quantity: 1 }]);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('currently unavailable');
  });
});

describe('Pre-orders on PATCH /api/orders/:id/status', () => {
  it('takes no stock for a pre-order line and returns none on cancel', async () => {
    const token = await getAdminToken();
    await Product.updateOne({ _id: preorderId }, { $set: { stock: 0 } });
    const order = await placeOrder([{ productId: preorderId, quantity: 1 }]);
    await Product.updateOne({ _id: preorderId }, { $set: { stock: 3 } });

    expect((await setStatus(token, order.body.data._id, 'Processing')).status).toBe(200);
    expect((await Product.findById(preorderId))?.stock).toBe(3);

    expect((await setStatus(token, order.body.data._id, 'Cancelled')).status).toBe(200);
    expect((await Product.findById(preorderId))?.stock).toBe(3);
  });

  it('turns a line into a pre-order when someone else bought the last piece first', async () => {
    const token = await getAdminToken();
    const first = await placeOrder([{ productId: preorderId, quantity: 1 }]);
    const second = await placeOrder([
      { productId: preorderId, quantity: 1 },
      { productId: plainId, quantity: 1 }
    ]);

    expect((await setStatus(token, first.body.data._id, 'Processing')).status).toBe(200);
    const res = await setStatus(token, second.body.data._id, 'Processing');

    expect(res.status).toBe(200);
    expect(res.body.data.items[0].preorder).toBe(true);
    expect(res.body.data.items[0].preorderDays).toBe(20);
    expect(res.body.data.items[1].preorder).toBe(false);

    const stored = await Order.findById(second.body.data._id);
    expect(stored?.items[0].preorder).toBe(true);
    expect((await Product.findById(preorderId))?.stock).toBe(0);
    expect((await Product.findById(plainId))?.stock).toBe(0);

    // Cancelling gives back only the plain line's stock
    expect((await setStatus(token, second.body.data._id, 'Cancelled')).status).toBe(200);
    expect((await Product.findById(preorderId))?.stock).toBe(0);
    expect((await Product.findById(plainId))?.stock).toBe(1);
  });

  it('leaves the order untouched when a later line lacks stock and allows no pre-order', async () => {
    const token = await getAdminToken();
    const order = await placeOrder([
      { productId: preorderId, quantity: 1 },
      { productId: plainId, quantity: 1 }
    ]);
    await Product.updateMany({}, { $set: { stock: 0 } });

    const res = await setStatus(token, order.body.data._id, 'Processing');

    expect(res.status).toBe(409);
    const stored = await Order.findById(order.body.data._id);
    expect(stored?.status).toBe('Pending');
    expect(stored?.items[0].preorder).toBe(false);
  });
});

describe('Pre-order fields on products', () => {
  it('defaults to no pre-orders and a 15 day wait', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        slug: 'preorder-defaults',
        name: 'Defaults Saree',
        price: 900,
        images: ['https://picsum.photos/seed/defaults/800/1200'],
        stock: 0
      });

    expect(res.status).toBe(201);
    expect(res.body.data.allowPreorder).toBe(false);
    expect(res.body.data.preorderDays).toBe(15);
  });

  it('rejects a wait outside 1 to 90 days', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        slug: 'preorder-too-long',
        name: 'Too Long Saree',
        price: 900,
        images: ['https://picsum.photos/seed/long/800/1200'],
        stock: 0,
        allowPreorder: true,
        preorderDays: 120
      });

    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toContain('preorderDays');
  });
});
