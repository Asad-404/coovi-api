import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import app from '../src/app';
import Admin from '../src/models/Admin';

const OWNER = { email: 'testadmin@coovi.com', password: 'testpass123' };
const MISSING_ID = '507f1f77bcf86cd799439011';

const login = async (email: string, password: string) =>
  request(app).post('/api/auth/login').send({ email, password });

const tokenFor = async (email: string, password: string): Promise<string> => {
  const res = await login(email, password);
  expect(res.status).toBe(200);
  return res.body.data.token as string;
};

let ownerToken: string;

const addStaff = async (email: string, password = 'staff-pass-123') => {
  const res = await request(app)
    .post('/api/admins')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email, name: 'Helper', role: 'staff', password });
  expect(res.status).toBe(201);
  return res.body.data as { _id: string; email: string; role: string; active: boolean };
};

beforeAll(async () => {
  ownerToken = await tokenFor(OWNER.email, OWNER.password);
});

describe('sign out everywhere on password change', () => {
  it('stops older tokens and gives this device a fresh one', async () => {
    const otherDevice = await tokenFor(OWNER.email, OWNER.password);
    const thisDevice = await tokenFor(OWNER.email, OWNER.password);

    const change = await request(app)
      .patch('/api/auth/password')
      .set('Authorization', `Bearer ${thisDevice}`)
      .send({ currentPassword: OWNER.password, newPassword: 'changed-pass-123' });
    expect(change.status).toBe(200);
    const fresh = change.body.data.token as string;

    for (const old of [otherDevice, thisDevice]) {
      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${old}`);
      expect(res.status).toBe(401);
    }
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${fresh}`);
    expect(me.status).toBe(200);
    expect(me.body.data.tokenVersion).toBeUndefined();

    // Put the original password back for the rest of the file
    const restore = await request(app)
      .patch('/api/auth/password')
      .set('Authorization', `Bearer ${fresh}`)
      .send({ currentPassword: 'changed-pass-123', newPassword: OWNER.password });
    expect(restore.status).toBe(200);
    ownerToken = restore.body.data.token;
  });

  it('refuses a token signed before token versions existed', async () => {
    const owner = await Admin.findOne({ email: OWNER.email }).lean();
    const legacy = jwt.sign({ id: owner!._id, email: OWNER.email, role: 'admin' }, process.env.JWT_SECRET!, {
      expiresIn: '1d'
    });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${legacy}`);
    expect(res.status).toBe(401);
  });
});

describe('owner and staff roles', () => {
  it('lets the owner add staff who can sign in and work on orders', async () => {
    const staff = await addStaff('helper1@coovi.com');
    expect(staff.role).toBe('staff');
    expect(staff).not.toHaveProperty('passwordHash');
    expect(staff).not.toHaveProperty('tokenVersion');

    const staffToken = await tokenFor('helper1@coovi.com', 'staff-pass-123');
    const orders = await request(app).get('/api/orders').set('Authorization', `Bearer ${staffToken}`);
    expect(orders.status).toBe(200);
    const settings = await request(app).get('/api/settings/admin').set('Authorization', `Bearer ${staffToken}`);
    expect(settings.status).toBe(200);
  });

  it('keeps money, settings, team and product delete for the owner', async () => {
    await addStaff('helper2@coovi.com');
    const staffToken = await tokenFor('helper2@coovi.com', 'staff-pass-123');
    const auth = { Authorization: `Bearer ${staffToken}` };

    const blocked = [
      await request(app).get('/api/courier-payments').set(auth),
      await request(app).get('/api/courier-payments/unpaid').set(auth),
      await request(app).patch('/api/settings').set(auth).send({ announcement: 'x' }),
      await request(app).delete(`/api/products/${MISSING_ID}`).set(auth),
      await request(app).get('/api/admins').set(auth),
      await request(app).post('/api/admins').set(auth).send({ email: 'x@coovi.com', name: 'X', role: 'owner', password: 'whatever-123' })
    ];
    for (const res of blocked) {
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Only the shop owner can do this');
    }

    // The owner gets past the role check on the same routes
    const ownerDelete = await request(app)
      .delete(`/api/products/${MISSING_ID}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(ownerDelete.status).toBe(404);
    const ownerPayments = await request(app).get('/api/courier-payments').set('Authorization', `Bearer ${ownerToken}`);
    expect(ownerPayments.status).toBe(200);
  });

  it('switching an account off signs it out at once and blocks sign-in', async () => {
    const staff = await addStaff('helper3@coovi.com');
    const staffToken = await tokenFor('helper3@coovi.com', 'staff-pass-123');

    const off = await request(app)
      .patch(`/api/admins/${staff._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body.data.active).toBe(false);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${staffToken}`);
    expect(me.status).toBe(401);
    const again = await login('helper3@coovi.com', 'staff-pass-123');
    expect(again.status).toBe(403);
    expect(again.body.data).toBeUndefined();

    // A wrong password on a switched-off account still says only "invalid"
    const wrong = await login('helper3@coovi.com', 'not-the-password');
    expect(wrong.status).toBe(401);

    const on = await request(app)
      .patch(`/api/admins/${staff._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ active: true });
    expect(on.status).toBe(200);
    expect((await login('helper3@coovi.com', 'staff-pass-123')).status).toBe(200);
  });

  it('a role change takes effect at once', async () => {
    const staff = await addStaff('helper4@coovi.com');
    const staffToken = await tokenFor('helper4@coovi.com', 'staff-pass-123');

    const promote = await request(app)
      .patch(`/api/admins/${staff._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'owner' });
    expect(promote.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${staffToken}`)).status).toBe(401);

    const ownerNow = await tokenFor('helper4@coovi.com', 'staff-pass-123');
    const team = await request(app).get('/api/admins').set('Authorization', `Bearer ${ownerNow}`);
    expect(team.status).toBe(200);

    // Back to staff so the last-owner test below starts from one owner
    const demote = await request(app)
      .patch(`/api/admins/${staff._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'staff' });
    expect(demote.status).toBe(200);
  });

  it('resetting a password signs the person out and sets the new one', async () => {
    const staff = await addStaff('helper5@coovi.com');
    const staffToken = await tokenFor('helper5@coovi.com', 'staff-pass-123');

    const reset = await request(app)
      .post(`/api/admins/${staff._id}/reset-password`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ password: 'new-temp-pass-1' });
    expect(reset.status).toBe(200);

    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${staffToken}`)).status).toBe(401);
    expect((await login('helper5@coovi.com', 'staff-pass-123')).status).toBe(401);
    expect((await login('helper5@coovi.com', 'new-temp-pass-1')).status).toBe(200);
  });

  it('never leaves the shop without an active owner', async () => {
    const owner = await Admin.findOne({ email: OWNER.email }).lean();
    const auth = { Authorization: `Bearer ${ownerToken}` };

    const demote = await request(app).patch(`/api/admins/${owner!._id}`).set(auth).send({ role: 'staff' });
    expect(demote.status).toBe(409);
    const off = await request(app).patch(`/api/admins/${owner!._id}`).set(auth).send({ active: false });
    expect(off.status).toBe(409);

    // Renaming yourself is fine
    const rename = await request(app).patch(`/api/admins/${owner!._id}`).set(auth).send({ name: 'Shop owner' });
    expect(rename.status).toBe(200);
    expect(rename.body.data.name).toBe('Shop owner');
  });

  it('validates team input', async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    await addStaff('helper6@coovi.com');

    const duplicate = await request(app)
      .post('/api/admins')
      .set(auth)
      .send({ email: 'HELPER6@coovi.com', name: 'Again', role: 'staff', password: 'staff-pass-123' });
    expect(duplicate.status).toBe(409);

    const bad = [
      { email: 'not-an-email', name: 'X', role: 'staff', password: 'staff-pass-123' },
      { email: 'ok@coovi.com', name: 'X', role: 'admin', password: 'staff-pass-123' },
      { email: 'ok@coovi.com', name: 'X', role: 'staff', password: 'short' },
      { email: 'ok@coovi.com', name: 'X', role: 'staff', password: 'staff-pass-123', active: false }
    ];
    for (const body of bad) {
      expect((await request(app).post('/api/admins').set(auth).send(body)).status).toBe(400);
    }

    expect((await request(app).patch('/api/admins/not-an-id').set(auth).send({ name: 'X' })).status).toBe(404);
    expect((await request(app).patch(`/api/admins/${MISSING_ID}`).set(auth).send({ name: 'X' })).status).toBe(404);
    const empty = await Admin.findOne({ email: 'helper6@coovi.com' }).lean();
    expect((await request(app).patch(`/api/admins/${empty!._id}`).set(auth).send({})).status).toBe(400);

    const owner = await Admin.findOne({ email: OWNER.email }).lean();
    const self = await request(app)
      .post(`/api/admins/${owner!._id}/reset-password`)
      .set(auth)
      .send({ password: 'whatever-123' });
    expect(self.status).toBe(400);
  });

  it('treats an account from before roles existed as an owner', async () => {
    await Admin.create({
      email: 'legacy@coovi.com',
      passwordHash: await bcrypt.hash('legacy-pass-123', 10),
      role: 'admin'
    });
    const legacyToken = await tokenFor('legacy@coovi.com', 'legacy-pass-123');
    const team = await request(app).get('/api/admins').set('Authorization', `Bearer ${legacyToken}`);
    expect(team.status).toBe(200);
  });
});
