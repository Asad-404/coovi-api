import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';

// Prices in the DB are the ONLY source of truth — the client sends quantities
const PRODUCTS = [
  {
    slug: 'order-test-red-saree',
    name: 'Red Test Saree',
    price: 1000,
    images: ['https://picsum.photos/seed/red/800/1200'],
    category: 'Saree',
    stock: 5,
    inStock: true
  },
  {
    slug: 'order-test-blue-saree',
    name: 'Blue Test Saree',
    price: 250,
    images: ['https://picsum.photos/seed/blue/800/1200'],
    category: 'Saree',
    stock: 3,
    inStock: true
  }
];

let redId = '';
let blueId = '';

async function seedProducts(): Promise<void> {
  await Product.deleteMany({});
  await Order.deleteMany({});
  const created = await Product.create(PRODUCTS);
  redId = String(created[0]._id);
  blueId = String(created[1]._id);
}

function validOrderBody(): any {
  return {
    customerName: 'Test Customer',
    phone: '01712345678',
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    items: [{ productId: redId, quantity: 2 }]
  };
}

afterEach(() => {
  delete process.env.DELIVERY_FEE;
});

describe('POST /api/orders (server-computed totals — CC-1)', () => {
  beforeAll(seedProducts);

  it('recomputes totals from DB prices and IGNORES spoofed client values', async () => {
    // A malicious/stale client sends fake prices and totals — including a total of 1
    const res = await request(app)
      .post('/api/orders')
      .send({
        ...validOrderBody(),
        subtotal: 1,
        deliveryFee: 0,
        total: 1,
        items: [
          // item-level fakes too: wrong name, price, image
          { productId: redId, quantity: 2, name: 'Fake Name', price: 1, image: 'https://evil.example/fake.jpg' }
        ]
      });

    expect(res.status).toBe(201);
    expect(res.body.data.subtotal).toBe(2000); // 2 x DB price 1000
    expect(res.body.data.deliveryFee).toBe(60); // server default
    expect(res.body.data.total).toBe(2060);
    expect(res.body.data.items[0].price).toBe(1000);
    expect(res.body.data.items[0].name).toBe('Red Test Saree');
    expect(res.body.data.items[0].image).toBe('https://picsum.photos/seed/red/800/1200');
  });

  it('computes a multi-item order correctly', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        ...validOrderBody(),
        items: [
          { productId: redId, quantity: 1 },
          { productId: blueId, quantity: 3 }
        ]
      });

    expect(res.status).toBe(201);
    expect(res.body.data.subtotal).toBe(1000 + 3 * 250);
    expect(res.body.data.total).toBe(1750 + 60);
  });

  it('reads DELIVERY_FEE from the environment (CC-3)', async () => {
    process.env.DELIVERY_FEE = '40';
    const res = await request(app).post('/api/orders').send(validOrderBody());

    expect(res.status).toBe(201);
    expect(res.body.data.deliveryFee).toBe(40);
    expect(res.body.data.total).toBe(2000 + 40);
  });

  it('rejects an unknown productId with 400', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        ...validOrderBody(),
        items: [{ productId: '000000000000000000000000', quantity: 1 }]
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects a quantity above available stock with 400', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        ...validOrderBody(),
        items: [{ productId: redId, quantity: 6 }] // stock is 5
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Only 5 left');
  });

  it('rejects an invalid Bangladeshi phone number with 400', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ ...validOrderBody(), phone: '12345' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects a missing address with 400 (not 500)', async () => {
    const { address, ...noAddress } = validOrderBody();
    const res = await request(app).post('/api/orders').send(noAddress);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
