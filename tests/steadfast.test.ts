import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Order from '../src/models/Order';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

// Never call the real Steadfast from tests: every request goes to this fake fetch
const fetchMock = vi.fn();

function steadfastReplies(body: unknown, httpStatus = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: httpStatus, headers: { 'Content-Type': 'application/json' } })
  );
}

const BOOKED = {
  status: 200,
  message: 'Consignment has been created successfully.',
  consignment: {
    consignment_id: 1424107,
    invoice: 'ORD-20261013-001',
    tracking_code: '15BAEB8A',
    status: 'in_review'
  }
};

let token = '';
let orderId = '';

async function makeOrder(overrides: Record<string, unknown> = {}) {
  const order = await Order.create({
    orderNumber: 'ORD-20261013-001',
    customerName: 'Steadfast Test Customer',
    phone: '01712345678',
    address: 'House 12, Road 5, Dhanmondi, Dhaka',
    notes: 'Call before coming',
    items: [{ productId: 'p1', name: 'Katan Saree', price: 5000, quantity: 1, image: 'https://example.com/a.jpg' }],
    subtotal: 5000,
    deliveryFee: 60,
    total: 5060,
    status: 'Processing',
    ...overrides
  });
  return String(order._id);
}

const book = (id = orderId) =>
  request(app).post(`/api/orders/${id}/courier/steadfast`).set('Authorization', `Bearer ${token}`);

const refresh = (id = orderId) =>
  request(app).post(`/api/orders/${id}/courier/steadfast/refresh`).set('Authorization', `Bearer ${token}`);

beforeEach(async () => {
  process.env.STEADFAST_API_KEY = 'test-api-key';
  process.env.STEADFAST_SECRET_KEY = 'test-secret-key';
  delete process.env.STEADFAST_BASE_URL;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);

  await Order.deleteMany({});
  orderId = await makeOrder();

  // supertest talks to the app over a real socket, not fetch, so login is unaffected
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  token = login.body.data.token;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/orders/:id/courier/steadfast', () => {
  it('refuses a viewer without order edit access and never calls Steadfast', async () => {
    const created = await request(app)
      .post('/api/admins')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `viewer-${Date.now()}@coovi.com`, name: 'Viewer', role: 'viewer', password: 'viewer-pass-123' });
    expect(created.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ email: created.body.data.email, password: 'viewer-pass-123' });

    const res = await request(app)
      .post(`/api/orders/${orderId}/courier/steadfast`)
      .set('Authorization', `Bearer ${login.body.data.token}`);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 401 without a token and never calls Steadfast', async () => {
    const res = await request(app).post(`/api/orders/${orderId}/courier/steadfast`);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('books the parcel with the server-computed total and saves the tracking code', async () => {
    steadfastReplies(BOOKED);

    const res = await book();

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.courier).toMatchObject({
      name: 'Steadfast',
      consignmentId: 1424107,
      trackingCode: '15BAEB8A',
      status: 'in_review'
    });
    expect(res.body.data.courier.bookingStartedAt).toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://portal.packzy.com/api/v1/create_order');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Api-Key': 'test-api-key', 'Secret-Key': 'test-secret-key' });
    expect(JSON.parse(init.body)).toEqual({
      invoice: 'ORD-20261013-001',
      recipient_name: 'Steadfast Test Customer',
      recipient_phone: '01712345678',
      recipient_address: 'House 12, Road 5, Dhanmondi, Dhaka',
      cod_amount: 5060,
      note: 'Call before coming'
    });

    const saved = await Order.findById(orderId);
    expect(saved?.courier?.trackingCode).toBe('15BAEB8A');
    // Booking does not change the order's own status
    expect(saved?.status).toBe('Processing');
  });

  it('refuses a second booking of the same order', async () => {
    steadfastReplies(BOOKED);
    await book();

    const res = await book();
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/15BAEB8A/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('books only once when two requests arrive together', async () => {
    steadfastReplies(BOOKED);
    steadfastReplies(BOOKED);

    const results = await Promise.all([book(), book()]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 409]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['Pending', 'Shipped', 'Delivered', 'Cancelled'])('refuses a %s order', async (status) => {
    await Order.deleteMany({});
    const id = await makeOrder({ status });

    const res = await book(id);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Only Processing orders/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds the district to the address when the address does not name it', async () => {
    await Order.updateOne({ _id: orderId }, { $set: { address: 'House 3, Road 1, Agrabad', district: 'Chattogram' } });
    steadfastReplies(BOOKED);

    expect((await book()).status).toBe(201);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).recipient_address).toBe('House 3, Road 1, Agrabad, Chattogram');
  });

  it('does not repeat a district the address already names', async () => {
    await Order.updateOne({ _id: orderId }, { $set: { district: 'Dhaka' } });
    steadfastReplies(BOOKED);

    await book();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).recipient_address).toBe('House 12, Road 5, Dhanmondi, Dhaka');
  });

  it('returns 404 for an unknown order', async () => {
    const res = await book('64b000000000000000000000');
    expect(res.status).toBe(404);
  });

  it('refuses an address longer than Steadfast allows, and can book after it is shortened', async () => {
    await Order.updateOne({ _id: orderId }, { $set: { address: 'x'.repeat(251) } });

    const res = await book();
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/250/);
    expect(fetchMock).not.toHaveBeenCalled();

    await Order.updateOne({ _id: orderId }, { $set: { address: 'House 1, Dhaka' } });
    steadfastReplies(BOOKED);
    expect((await book()).status).toBe(201);
  });

  it('returns 503 when the Steadfast keys are not set', async () => {
    delete process.env.STEADFAST_SECRET_KEY;

    const res = await book();
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await Order.findById(orderId))?.courier).toBeUndefined();
  });

  it('passes on Steadfast validation errors as 502 and leaves the order bookable', async () => {
    steadfastReplies({ status: 400, errors: { invoice: ['The invoice has already been taken.'] } });

    const res = await book();
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('Steadfast: The invoice has already been taken.');
    expect((await Order.findById(orderId))?.courier).toBeUndefined();

    steadfastReplies(BOOKED);
    expect((await book()).status).toBe(201);
  });

  it('reports wrong keys (HTTP 401) as 502', async () => {
    steadfastReplies({ message: 'Unauthorized' }, 401);

    const res = await book();
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('Steadfast: Unauthorized');
  });

  it('reports a network failure as 502', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const res = await book();
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/Could not reach Steadfast/);
    expect((await Order.findById(orderId))?.courier).toBeUndefined();
  });

  it('uses STEADFAST_BASE_URL when set', async () => {
    process.env.STEADFAST_BASE_URL = 'https://sandbox.example.com/api/v1/';
    steadfastReplies(BOOKED);

    await book();
    expect(fetchMock.mock.calls[0][0]).toBe('https://sandbox.example.com/api/v1/create_order');
  });

  it('lets a retry through once a stuck booking is older than a minute', async () => {
    await Order.updateOne({ _id: orderId }, { $set: { 'courier.bookingStartedAt': new Date() } });
    expect((await book()).status).toBe(409);

    await Order.updateOne({ _id: orderId }, { $set: { 'courier.bookingStartedAt': new Date(Date.now() - 120_000) } });
    steadfastReplies(BOOKED);
    expect((await book()).status).toBe(201);
  });
});

describe('POST /api/orders/:id/courier/steadfast/refresh', () => {
  it('saves the latest Steadfast status without changing the order status', async () => {
    steadfastReplies(BOOKED);
    await book();
    steadfastReplies({ status: 200, delivery_status: 'delivered' });

    const res = await refresh();

    expect(res.status).toBe(200);
    expect(res.body.data.courier.status).toBe('delivered');
    expect(res.body.data.courier.trackingCode).toBe('15BAEB8A');
    expect(res.body.data.status).toBe('Processing');
    expect(fetchMock.mock.calls[1][0]).toBe('https://portal.packzy.com/api/v1/status_by_cid/1424107');
  });

  it('returns 409 for an order that was never booked', async () => {
    const res = await refresh();
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 and keeps the old status when Steadfast fails', async () => {
    steadfastReplies(BOOKED);
    await book();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const res = await refresh();
    expect(res.status).toBe(502);
    expect((await Order.findById(orderId))?.courier?.status).toBe('in_review');
  });
});

describe('GET /api/orders/:orderNumber (public)', () => {
  it('shows the tracking code to the customer', async () => {
    steadfastReplies(BOOKED);
    await book();

    const res = await request(app).get('/api/orders/ORD-20261013-001').query({ phone: '01712345678' });
    expect(res.status).toBe(200);
    expect(res.body.data.courier.trackingCode).toBe('15BAEB8A');
  });
});
