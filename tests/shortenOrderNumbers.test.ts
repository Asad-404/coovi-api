import { beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import Order from '../src/models/Order';
import CourierPayment from '../src/models/CourierPayment';
import { applyOrderNumberChanges, planOrderNumberChanges } from '../src/scripts/orderNumberMigration';

const SHORT = /^[2-9A-HJKMNP-TV-Z]{6}$/;

const insertOrder = async (orderNumber: string, fields: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({ _id, orderNumber, createdAt: new Date('2026-10-20T06:00:00Z'), ...fields });
  return _id;
};

const numberOf = async (id: mongoose.Types.ObjectId) => (await Order.findById(id).lean())?.orderNumber;

const migrate = async () => {
  const plan = await planOrderNumberChanges();
  await applyOrderNumberChanges(plan);
  return plan;
};

beforeEach(async () => {
  await Order.init();
  await Order.deleteMany({});
  await CourierPayment.deleteMany({});
});

describe('order number migration', () => {
  it('keeps the last 6 characters of a long number', async () => {
    const id = await insertOrder('ORD-20261013-K7M3QX');

    const plan = await migrate();

    expect(await numberOf(id)).toBe('K7M3QX');
    expect(plan.freshCodes).toEqual([]);
  });

  it('leaves the older order with a shared code and gives the newer one a fresh code', async () => {
    const newer = await insertOrder('ORD-20261014-K7M3QX', { createdAt: new Date('2026-10-14T06:00:00Z') });
    const older = await insertOrder('ORD-20261013-K7M3QX', { createdAt: new Date('2026-10-13T06:00:00Z') });

    const plan = await migrate();

    expect(await numberOf(older)).toBe('K7M3QX');
    expect(await numberOf(newer)).toMatch(SHORT);
    expect(await numberOf(newer)).not.toBe('K7M3QX');
    expect(plan.freshCodes.map((c) => c.from)).toEqual(['ORD-20261014-K7M3QX']);
  });

  it('does not take a code already used by a short number', async () => {
    const existing = await insertOrder('K7M3QX');
    const old = await insertOrder('ORD-20261013-K7M3QX');

    await migrate();

    expect(await numberOf(existing)).toBe('K7M3QX');
    expect(await numberOf(old)).toMatch(SHORT);
    expect(await numberOf(old)).not.toBe('K7M3QX');
  });

  it('gives an old 3-digit number a fresh code and reports it', async () => {
    const id = await insertOrder('ORD-20261001-123');

    const plan = await migrate();

    expect(await numberOf(id)).toMatch(SHORT);
    expect(plan.freshCodes.map((c) => c.from)).toEqual(['ORD-20261001-123']);
  });

  it('updates courier payment lines and leaves the rest of the payment alone', async () => {
    const id = await insertOrder('ORD-20261013-K7M3QX');
    const deletedOrder = new mongoose.Types.ObjectId();
    const updatedAt = new Date('2026-10-21T06:00:00Z');
    const line = { orderTotal: 1000, collected: 1000, charge: 60, net: 940 };
    const { insertedId } = await CourierPayment.collection.insertOne({
      courier: 'Steadfast',
      updatedAt,
      lines: [
        { ...line, order: id, orderNumber: 'ORD-20261013-K7M3QX' },
        { ...line, order: deletedOrder, orderNumber: 'ORD-20261012-ABCDEF' }
      ]
    });

    const plan = await migrate();
    const payment = await CourierPayment.findById(insertedId).lean();

    expect(plan.courierPaymentsToUpdate).toBe(1);
    expect(payment?.lines.map((l) => l.orderNumber)).toEqual(['K7M3QX', 'ORD-20261012-ABCDEF']);
    expect(payment?.lines[0].net).toBe(940);
    expect(payment?.updatedAt).toEqual(updatedAt);
  });

  it('writes nothing while only planning', async () => {
    const id = await insertOrder('ORD-20261013-K7M3QX');

    const plan = await planOrderNumberChanges();

    expect(plan.changes).toEqual([{ id: String(id), from: 'ORD-20261013-K7M3QX', to: 'K7M3QX' }]);
    expect(await numberOf(id)).toBe('ORD-20261013-K7M3QX');
  });

  it('finds nothing to do on a second run', async () => {
    await insertOrder('ORD-20261013-K7M3QX');
    await insertOrder('ORD-20261001-123');
    await migrate();

    const second = await planOrderNumberChanges();

    expect(second.changes).toEqual([]);
    expect(second.courierPaymentsToUpdate).toBe(0);
  });

  it('refuses to apply while a Steadfast booking is unfinished', async () => {
    const id = await insertOrder('ORD-20261013-K7M3QX', { courier: { bookingStartedAt: new Date() } });
    await insertOrder('ORD-20261014-ABCDEF', { courier: { bookingStartedAt: new Date(), trackingCode: 'T1' } });

    const plan = await planOrderNumberChanges();

    expect(plan.unfinishedBookings).toEqual(['ORD-20261013-K7M3QX']);
    await expect(applyOrderNumberChanges(plan)).rejects.toThrow('ORD-20261013-K7M3QX');
    expect(await numberOf(id)).toBe('ORD-20261013-K7M3QX');
  });
});
