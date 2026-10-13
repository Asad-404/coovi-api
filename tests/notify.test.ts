import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import { buildNewOrderEmail, notifyNewOrder } from '../src/services/notify';

const ORDER = {
  orderNumber: 'ORD-20261013-123',
  customerName: 'Rina <b>Akter</b>',
  phone: '01712345678',
  address: 'House 12, Road 5, Dhanmondi, Dhaka',
  notes: 'Call after 5pm',
  items: [
    { productId: 'a', name: 'Red Katan', price: 5000, quantity: 1, image: 'x' },
    { productId: 'b', name: 'Blue Silk', price: 3000, quantity: 2, image: 'y', preorder: true, preorderDays: 20 }
  ],
  subtotal: 11000,
  deliveryFee: 60,
  total: 11060
};

const CONFIGURED = { EMAIL_API_KEY: 're_test_key', NOTIFY_EMAIL_TO: 'owner@example.com, helper@example.com' } as NodeJS.ProcessEnv;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('buildNewOrderEmail', () => {
  it('lists the customer, items, pre-orders and total, with HTML escaped', () => {
    const email = buildNewOrderEmail(ORDER, 'https://admin.example.com/');

    expect(email.subject).toBe('New order ORD-20261013-123: ৳11060 (includes pre-order)');
    expect(email.text).toContain('Phone: 01712345678');
    expect(email.text).toContain('Blue Silk (pre-order, about 20 days) x 2 = ৳6000');
    expect(email.text).toContain('Open the admin: https://admin.example.com/orders');
    expect(email.html).toContain('Rina &lt;b&gt;Akter&lt;/b&gt;');
    expect(email.html).not.toContain('<b>Akter</b>');
  });

  it('leaves out the admin link when no address is set', () => {
    const email = buildNewOrderEmail({ ...ORDER, items: [ORDER.items[0]] });

    expect(email.subject).toBe('New order ORD-20261013-123: ৳11060');
    expect(email.text).not.toContain('Open the admin');
  });
});

describe('notifyNewOrder', () => {
  it('sends one email through Resend when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyNewOrder(ORDER, CONFIGURED);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(['owner@example.com', 'helper@example.com']);
    expect(body.from).toBe('Coovi Orders <onboarding@resend.dev>');
    expect(body.subject).toContain('ORD-20261013-123');
  });

  it('does nothing when email is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await notifyNewOrder(ORDER, {} as NodeJS.ProcessEnv);
    await notifyNewOrder(ORDER, { EMAIL_API_KEY: 're_test_key' } as NodeJS.ProcessEnv);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows network errors and rejected sends', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(notifyNewOrder(ORDER, CONFIGURED)).resolves.toBeUndefined();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad key', { status: 401 })));
    await expect(notifyNewOrder(ORDER, CONFIGURED)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/orders with alerts on', () => {
  let productId = '';

  beforeAll(async () => {
    await Product.deleteMany({});
    const product = await Product.create({
      slug: 'notify-test-saree',
      name: 'Notify Test Saree',
      price: 1500,
      images: ['https://picsum.photos/seed/notify/800/1200'],
      stock: 5
    });
    productId = String(product._id);
  });

  it('emails the new order and still returns 201 when the email fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('EMAIL_API_KEY', 're_test_key');
    vi.stubEnv('NOTIFY_EMAIL_TO', 'owner@example.com');
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app).post('/api/orders').send({
      customerName: 'Alert Test Customer',
      phone: '01712345678',
      address: 'House 12, Road 5, Dhanmondi, Dhaka',
      items: [{ productId, quantity: 1 }]
    });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).subject).toContain(res.body.data.orderNumber);
  });
});
