import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import { buildOrderConfirmationSms, getSmsProvider, sendOrderConfirmationSms } from '../src/services/sms';

const ORDER = { orderNumber: 'ORD-20261013-123', phone: '01712345678', total: 11060 };

const CONFIGURED = { SMS_PROVIDER: 'alpha', SMS_API_KEY: 'test-sms-key' } as NodeJS.ProcessEnv;

const alphaReply = (body: object, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('buildOrderConfirmationSms', () => {
  it('fits one plain-text SMS, even with the tracking link', () => {
    const sms = buildOrderConfirmationSms(ORDER, 'https://coovi-storefront.vercel.app/');

    expect(sms).toBe(
      'Coovi: order ORD-20261013-123 received. Total Tk 11060, cash on delivery. We will call you to confirm. Track: https://coovi-storefront.vercel.app/track-order'
    );
    expect(sms.length).toBeLessThanOrEqual(160);
    // A single non-GSM character (such as ৳ or Bengali) would make it a 70-character Unicode SMS
    expect(sms).toMatch(/^[\x20-\x7E]*$/);
  });

  it('leaves out the link when no storefront address is set', () => {
    expect(buildOrderConfirmationSms(ORDER)).not.toContain('Track');
  });
});

describe('getSmsProvider', () => {
  it('is off unless both the provider and the key are set', () => {
    expect(getSmsProvider({} as NodeJS.ProcessEnv)).toBeNull();
    expect(getSmsProvider({ SMS_PROVIDER: 'alpha' } as NodeJS.ProcessEnv)).toBeNull();
    expect(getSmsProvider({ SMS_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBeNull();
    expect(getSmsProvider({ ...CONFIGURED, SMS_PROVIDER: ' Alpha ' })?.name).toBe('alpha');
  });

  it('stays off for an unknown provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getSmsProvider({ ...CONFIGURED, SMS_PROVIDER: 'twilio' })).toBeNull();
  });
});

describe('sendOrderConfirmationSms', () => {
  it('posts one SMS to Alpha with the country code added', async () => {
    const fetchMock = vi.fn().mockResolvedValue(alphaReply({ error: 0, msg: 'Request successfully submitted' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOrderConfirmationSms(ORDER, { ...CONFIGURED, SMS_SENDER_ID: 'Coovi' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sms.net.bd/sendsms');
    expect(init.method).toBe('POST');
    const form = init.body as URLSearchParams;
    expect(form.get('api_key')).toBe('test-sms-key');
    expect(form.get('to')).toBe('8801712345678');
    expect(form.get('sender_id')).toBe('Coovi');
    expect(form.get('msg')).toContain('ORD-20261013-123');
  });

  it('does nothing when SMS is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await sendOrderConfirmationSms(ORDER, {} as NodeJS.ProcessEnv);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows network errors and refusals, without logging the phone number', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(sendOrderConfirmationSms(ORDER, CONFIGURED)).resolves.toBeUndefined();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(alphaReply({ error: 417, msg: 'Insufficient balance' })));
    await expect(sendOrderConfirmationSms(ORDER, CONFIGURED)).resolves.toBeUndefined();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })));
    await expect(sendOrderConfirmationSms(ORDER, CONFIGURED)).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(3);
    expect(String(log.mock.calls[1][1])).toContain('Insufficient balance');
    expect(log.mock.calls.flat().join(' ')).not.toContain('01712345678');
  });
});

describe('POST /api/orders with SMS on', () => {
  let productId = '';

  beforeAll(async () => {
    await Product.deleteMany({});
    const product = await Product.create({
      slug: 'sms-test-saree',
      name: 'SMS Test Saree',
      price: 1500,
      images: ['https://picsum.photos/seed/sms/800/1200'],
      stock: 5
    });
    productId = String(product._id);
  });

  it('texts the customer their order number and still returns 201 when the SMS fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('SMS_PROVIDER', 'alpha');
    vi.stubEnv('SMS_API_KEY', 'test-sms-key');
    const fetchMock = vi.fn().mockResolvedValue(alphaReply({ error: 417, msg: 'Insufficient balance' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app).post('/api/orders').send({
      customerName: 'SMS Test Customer',
      phone: '01812345678',
      address: 'House 12, Road 5, Dhanmondi, Dhaka',
      items: [{ productId, quantity: 1 }]
    });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const form = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(form.get('to')).toBe('8801812345678');
    expect(form.get('msg')).toContain(res.body.data.orderNumber);
  });
});
