import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Settings from '../src/models/Settings';
import { clearSettingsCache } from '../src/services/settings';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

async function token(): Promise<string> {
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  return login.body.data.token as string;
}

beforeEach(async () => {
  // init() waits for the unique index on `key`, which is what stops a second settings document
  await Settings.init();
  await Settings.deleteMany({});
  clearSettingsCache();
});

describe('GET /api/settings', () => {
  it('creates the settings with defaults on first read and returns only public fields', async () => {
    const res = await request(app).get('/api/settings');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      whatsappNumber: '8801700000000',
      supportPhone: '',
      announcementText: 'Shop the festive collection',
      announcementActive: true
    });
    expect(res.body.data).not.toHaveProperty('lowStockThreshold');
    expect(await Settings.countDocuments()).toBe(1);
  });

  it('makes only one settings document when two first reads arrive together', async () => {
    await Promise.all([request(app).get('/api/settings'), request(app).get('/api/settings')]);
    expect(await Settings.countDocuments()).toBe(1);
  });
});

describe('GET /api/settings/admin', () => {
  it('requires a token', async () => {
    const res = await request(app).get('/api/settings/admin');
    expect(res.status).toBe(401);
  });

  it('returns every setting, including admin-only ones', async () => {
    const res = await request(app)
      .get('/api/settings/admin')
      .set('Authorization', `Bearer ${await token()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.lowStockThreshold).toBe(6);
    expect(res.body.data.whatsappNumber).toBe('8801700000000');
  });
});

describe('PATCH /api/settings', () => {
  it('requires a token', async () => {
    const res = await request(app).patch('/api/settings').send({ announcementActive: false });
    expect(res.status).toBe(401);
  });

  it('saves only the fields sent and the public read shows the change at once', async () => {
    const adminToken = await token();
    // Warm the cache first: the save must clear it, not wait a minute
    await request(app).get('/api/settings');

    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ whatsappNumber: '8801712345678', supportPhone: '01812345678' });

    expect(res.status).toBe(200);
    expect(res.body.data.whatsappNumber).toBe('8801712345678');
    expect(res.body.data.supportPhone).toBe('01812345678');
    // Untouched fields keep their values
    expect(res.body.data.announcementText).toBe('Shop the festive collection');
    expect(res.body.data.lowStockThreshold).toBe(6);

    const pub = await request(app).get('/api/settings');
    expect(pub.body.data.whatsappNumber).toBe('8801712345678');
  });

  it('rejects unknown fields', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${await token()}`)
      .send({ deliveryFee: 0 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects an empty body', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${await token()}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it.each([
    { whatsappNumber: '01712345678' },
    { whatsappNumber: '8801212345678' },
    { supportPhone: '12345' },
    { announcementText: 'x'.repeat(121) },
    { lowStockThreshold: -1 },
    { lowStockThreshold: 2.5 },
    { announcementActive: 'yes' }
  ])('rejects invalid value %o', async (body) => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${await token()}`)
      .send(body);
    expect(res.status).toBe(400);
  });

  it('allows clearing the support phone', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${await token()}`)
      .send({ supportPhone: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.supportPhone).toBe('');
  });

  it('refuses to turn the announcement on with no text', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${await token()}`)
      .send({ announcementText: '   ', announcementActive: true });
    expect(res.status).toBe(400);
  });

  it('allows an empty announcement when it is switched off', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${await token()}`)
      .send({ announcementText: '', announcementActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.announcementActive).toBe(false);
  });
});
