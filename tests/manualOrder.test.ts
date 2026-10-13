import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

async function getAdminToken(): Promise<string> {
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  return login.body.data.token as string;
}

let sareeId = '';
let preorderId = '';
let token = '';

beforeEach(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const created = await Product.create([
    {
      slug: 'manual-test-jamdani',
      name: 'Jamdani Manual Saree',
      price: 3000,
      images: ['https://picsum.photos/seed/manual/800/1200'],
      stock: 2
    },
    {
      slug: 'manual-test-katan',
      name: 'Katan Manual Saree',
      price: 5000,
      images: ['https://picsum.photos/seed/manualpre/800/1200'],
      stock: 0,
      allowPreorder: true,
      preorderDays: 20
    }
  ]);
  sareeId = String(created[0]._id);
  preorderId = String(created[1]._id);
  token = await getAdminToken();
});

afterEach(() => {
  delete process.env.DELIVERY_FEE;
});

function manualBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerName: 'Facebook Customer',
    phone: '01812345678',
    address: 'House 3, Road 2, Mirpur, Dhaka',
    source: 'facebook',
    items: [{ productId: sareeId, quantity: 1 }],
    ...extra
  };
}

function postManual(body: Record<string, unknown>, auth = true) {
  const req = request(app).post('/api/orders/manual');
  if (auth) req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

describe('POST /api/orders/manual', () => {
  it('requires an admin token', async () => {
    const res = await postManual(manualBody(), false);
    expect(res.status).toBe(401);
    expect(await Order.countDocuments()).toBe(0);
  });

  it('creates a Pending order with database prices, the source and the admin who entered it', async () => {
    process.env.DELIVERY_FEE = '80';
    const res = await postManual(manualBody({ items: [{ productId: sareeId, quantity: 2 }] }));

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const order = res.body.data;
    expect(order.orderNumber).toMatch(/^ORD-\d{8}-\d{3}$/);
    expect(order.status).toBe('Pending');
    expect(order.source).toBe('facebook');
    expect(order.createdBy).toBe(TEST_ADMIN.email);
    expect(order.items[0].price).toBe(3000);
    expect(order.subtotal).toBe(6000);
    expect(order.discount).toBe(0);
    expect(order.deliveryFee).toBe(80);
    expect(order.total).toBe(6080);
  });

  it('takes no stock until the order is confirmed', async () => {
    await postManual(manualBody());
    const product = await Product.findById(sareeId);
    expect(product?.stock).toBe(2);
  });

  it('applies an agreed delivery fee and discount', async () => {
    const res = await postManual(manualBody({ deliveryFeeOverride: 0, discount: 500 }));

    expect(res.status).toBe(201);
    expect(res.body.data.subtotal).toBe(3000);
    expect(res.body.data.discount).toBe(500);
    expect(res.body.data.deliveryFee).toBe(0);
    expect(res.body.data.total).toBe(2500);
  });

  it('refuses a discount larger than the items subtotal', async () => {
    const res = await postManual(manualBody({ discount: 3001 }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Discount/);
    expect(await Order.countDocuments()).toBe(0);
  });

  it('rejects price or total fields instead of ignoring them', async () => {
    const res = await postManual(manualBody({ total: 1 }));
    expect(res.status).toBe(400);
    expect(await Order.countDocuments()).toBe(0);
  });

  it('rejects a missing or unknown source', async () => {
    const noSource = manualBody();
    delete noSource.source;
    expect((await postManual(noSource)).status).toBe(400);
    expect((await postManual(manualBody({ source: 'website' }))).status).toBe(400);
  });

  it('rejects negative or fractional money values', async () => {
    expect((await postManual(manualBody({ discount: -10 }))).status).toBe(400);
    expect((await postManual(manualBody({ deliveryFeeOverride: -1 }))).status).toBe(400);
    expect((await postManual(manualBody({ discount: 10.5 }))).status).toBe(400);
  });

  it('follows the same stock rules as checkout', async () => {
    const tooMany = await postManual(manualBody({ items: [{ productId: sareeId, quantity: 3 }] }));
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toMatch(/Only 2 left/);

    const preorder = await postManual(manualBody({ items: [{ productId: preorderId, quantity: 1 }] }));
    expect(preorder.status).toBe(201);
    expect(preorder.body.data.items[0].preorder).toBe(true);
    expect(preorder.body.data.items[0].preorderDays).toBe(20);
  });

  it('confirming a manual order takes stock like a website order', async () => {
    const res = await postManual(manualBody({ items: [{ productId: sareeId, quantity: 2 }] }));
    const confirm = await request(app)
      .patch(`/api/orders/${res.body.data._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'Processing' });

    expect(confirm.status).toBe(200);
    const product = await Product.findById(sareeId);
    expect(product?.stock).toBe(0);
  });
});

describe('Website orders', () => {
  it('are marked as source "website" with no discount', async () => {
    const res = await request(app).post('/api/orders').send({
      customerName: 'Web Customer',
      phone: '01712345678',
      address: 'House 12, Road 5, Dhanmondi, Dhaka',
      items: [{ productId: sareeId, quantity: 1 }],
      source: 'phone',
      discount: 3000
    });

    expect(res.status).toBe(201);
    expect(res.body.data.source).toBe('website');
    expect(res.body.data.discount).toBe(0);
    expect(res.body.data.createdBy).toBeUndefined();
    expect(res.body.data.total).toBe(3000 + 60);
  });
});
