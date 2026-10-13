import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

let token = '';
let productId = '';

const orderBody = (extra: object = {}) => ({
  customerName: 'Area Test Customer',
  phone: '01712345678',
  address: 'House 12, Road 5, Dhanmondi',
  items: [{ productId, quantity: 1 }],
  ...extra
});

const placeOrder = (extra: object = {}) => request(app).post('/api/orders').send(orderBody(extra));

const editOrder = (orderId: string, body: object) =>
  request(app).patch(`/api/orders/${orderId}`).set('Authorization', `Bearer ${token}`).send(body);

beforeAll(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const product = await Product.create({
    slug: 'area-test-saree',
    name: 'Area Test Saree',
    price: 1000,
    images: ['https://picsum.photos/seed/area/800/1200'],
    category: 'Saree',
    stock: 50,
    inStock: true
  });
  productId = String(product._id);
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  token = login.body.data.token;
});

afterEach(() => {
  delete process.env.DELIVERY_FEE;
  delete process.env.DELIVERY_FEE_INSIDE_DHAKA;
  delete process.env.DELIVERY_FEE_OUTSIDE_DHAKA;
});

describe('GET /api/orders/delivery-fee', () => {
  it('returns the fee per area and the district list', async () => {
    const res = await request(app).get('/api/orders/delivery-fee');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveryFee).toBe(70);
    expect(res.body.data.zones).toEqual({ inside_dhaka: 70, outside_dhaka: 130 });
    expect(res.body.data.districts).toHaveLength(64);
    expect(res.body.data.districts).toContain('Dhaka');
  });

  it('reads both fees from the environment, with DELIVERY_FEE as the old inside fee', async () => {
    process.env.DELIVERY_FEE = '50';
    process.env.DELIVERY_FEE_OUTSIDE_DHAKA = '150';
    let res = await request(app).get('/api/orders/delivery-fee');
    expect(res.body.data.zones).toEqual({ inside_dhaka: 50, outside_dhaka: 150 });

    process.env.DELIVERY_FEE_INSIDE_DHAKA = '80';
    res = await request(app).get('/api/orders/delivery-fee');
    expect(res.body.data.zones.inside_dhaka).toBe(80);
  });
});

describe('POST /api/orders with a district', () => {
  it('charges the inside-Dhaka fee for Dhaka city', async () => {
    const res = await placeOrder({ district: 'Dhaka', deliveryArea: 'inside_dhaka' });

    expect(res.status).toBe(201);
    expect(res.body.data.district).toBe('Dhaka');
    expect(res.body.data.deliveryArea).toBe('inside_dhaka');
    expect(res.body.data.deliveryFee).toBe(70);
    expect(res.body.data.total).toBe(1070);
  });

  it('charges the outside fee for Dhaka suburbs', async () => {
    const res = await placeOrder({ district: 'Dhaka', deliveryArea: 'outside_dhaka' });

    expect(res.status).toBe(201);
    expect(res.body.data.deliveryArea).toBe('outside_dhaka');
    expect(res.body.data.total).toBe(1130);
  });

  it('charges the outside fee for any other district, even without an area', async () => {
    const res = await placeOrder({ district: 'Chattogram' });

    expect(res.status).toBe(201);
    expect(res.body.data.deliveryArea).toBe('outside_dhaka');
    expect(res.body.data.deliveryFee).toBe(130);
  });

  it('refuses the cheaper inside-Dhaka fee for a district outside Dhaka', async () => {
    const res = await placeOrder({ district: 'Sylhet', deliveryArea: 'inside_dhaka' });

    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/only for district Dhaka/);
  });

  it('rejects an unknown district or area', async () => {
    expect((await placeOrder({ district: 'Atlantis' })).status).toBe(400);
    expect((await placeOrder({ deliveryArea: 'moon' })).status).toBe(400);
  });

  it('keeps an older client that sends no district working at the inside-Dhaka fee', async () => {
    const res = await placeOrder();

    expect(res.status).toBe(201);
    expect(res.body.data.deliveryArea).toBe('inside_dhaka');
    expect(res.body.data.district).toBeUndefined();
    expect(res.body.data.deliveryFee).toBe(70);
  });

  it('ignores a delivery fee sent by the client', async () => {
    const res = await placeOrder({ district: 'Khulna', deliveryFee: 0, total: 1000 });

    expect(res.status).toBe(201);
    expect(res.body.data.deliveryFee).toBe(130);
    expect(res.body.data.total).toBe(1130);
  });
});

describe('PATCH /api/orders/:id — delivery area', () => {
  it('recomputes the fee and total when the area changes', async () => {
    const placed = await placeOrder({ district: 'Dhaka' });
    const res = await editOrder(placed.body.data._id, { district: 'Rajshahi' });

    expect(res.status).toBe(200);
    expect(res.body.data.district).toBe('Rajshahi');
    expect(res.body.data.deliveryArea).toBe('outside_dhaka');
    expect(res.body.data.deliveryFee).toBe(130);
    expect(res.body.data.total).toBe(1130);
  });

  it('switches back to the city fee when the area alone changes', async () => {
    const placed = await placeOrder({ district: 'Dhaka', deliveryArea: 'outside_dhaka' });
    const res = await editOrder(placed.body.data._id, { deliveryArea: 'inside_dhaka' });

    expect(res.status).toBe(200);
    expect(res.body.data.deliveryFee).toBe(70);
    expect(res.body.data.total).toBe(1070);
  });

  it('keeps the fee charged at checkout when the area stays the same', async () => {
    process.env.DELIVERY_FEE_OUTSIDE_DHAKA = '100';
    const placed = await placeOrder({ district: 'Bogura' });
    process.env.DELIVERY_FEE_OUTSIDE_DHAKA = '200';
    const res = await editOrder(placed.body.data._id, { district: 'Pabna' });

    expect(res.status).toBe(200);
    expect(res.body.data.district).toBe('Pabna');
    expect(res.body.data.deliveryFee).toBe(100);
  });

  it('refuses inside Dhaka for a district outside Dhaka', async () => {
    const placed = await placeOrder({ district: 'Feni' });
    const res = await editOrder(placed.body.data._id, { deliveryArea: 'inside_dhaka' });

    expect(res.status).toBe(400);
  });

  it('only allows the change while the order is Pending', async () => {
    const placed = await placeOrder({ district: 'Dhaka' });
    const id = placed.body.data._id;
    await request(app).patch(`/api/orders/${id}/status`).set('Authorization', `Bearer ${token}`).send({ status: 'Processing' });

    const res = await editOrder(id, { district: 'Cumilla' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Pending/);

    // Contact details can still be corrected
    expect((await editOrder(id, { notes: 'Call first' })).status).toBe(200);
  });

  it('returns 404 for an unknown order', async () => {
    const res = await editOrder('000000000000000000000000', { district: 'Dhaka' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/orders?deliveryArea=', () => {
  it('filters by area, counting old orders without an area as inside Dhaka', async () => {
    await Order.deleteMany({});
    await placeOrder({ district: 'Dhaka' });
    await placeOrder({ district: 'Barishal' });
    await Order.collection.insertOne({
      orderNumber: 'ORD-20260101-001',
      customerName: 'Old Order',
      phone: '01712345678',
      address: 'Old address, Dhaka',
      items: [],
      subtotal: 0,
      deliveryFee: 60,
      total: 60,
      status: 'Pending',
      paymentMethod: 'Cash on Delivery'
    });

    const auth = { Authorization: `Bearer ${token}` };
    const inside = await request(app).get('/api/orders?deliveryArea=inside_dhaka').set(auth);
    const outside = await request(app).get('/api/orders?deliveryArea=outside_dhaka').set(auth);

    expect(inside.body.pagination.total).toBe(2);
    expect(outside.body.pagination.total).toBe(1);
    expect(outside.body.data[0].district).toBe('Barishal');
  });
});
