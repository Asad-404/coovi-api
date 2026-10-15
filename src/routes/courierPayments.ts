import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requireOwner } from '../middleware/auth';
import Order from '../models/Order';
import CourierPayment, { PAYMENT_METHODS } from '../models/CourierPayment';

// Cash on delivery money comes back through the courier, days after delivery,
// minus its charges. These routes record each payout by hand from the courier's
// statement and show which delivered orders the courier still owes money for.
// Every route is owner only: it is the shop's money.
const router = Router();
router.use(requireAdmin, requireOwner);

// Taka with paisa: round once on the server so totals never drift by 0.0000001
const round2 = (value: number): number => Math.round(value * 100) / 100;
const money = z.number().min(0).max(10_000_000).transform(round2);

// A parcel can be on a statement once the courier has it: Delivered, Returned
// (refused at the door, the courier only charges the return), or still Shipped
// when the statement arrives before the order status is updated
const PAYABLE_STATUSES = ['Shipped', 'Delivered', 'Returned'];

const paymentBodySchema = z.strictObject({
  courier: z.string().trim().min(1).max(50).optional(),
  paidAt: z.coerce
    .date()
    .refine((d) => !Number.isNaN(d.getTime()), 'paidAt must be a date')
    // a day of slack for time zones; a payment can't arrive later than tomorrow
    .refine((d) => d.getTime() <= Date.now() + 24 * 60 * 60 * 1000, 'paidAt cannot be in the future'),
  method: z.enum(PAYMENT_METHODS).optional(),
  reference: z.string().trim().max(100).optional(),
  // leave it out when the money that arrived matches the statement exactly
  amountReceived: money.optional(),
  notes: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.strictObject({
        orderNumber: z.string().trim().min(1).max(40),
        collected: money,
        charge: money
      })
    )
    .min(1)
    .max(500)
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().catch(1).transform((v) => Math.max(1, v)),
  limit: z.coerce.number().int().catch(20).transform((v) => Math.min(Math.max(1, v), 100))
});

// GET /api/courier-payments/unpaid - Delivered orders no payment covers yet.
// Registered before /:id so "unpaid" is not read as an id.
router.get('/unpaid', async (_req: Request, res: Response): Promise<void> => {
  const paidOrderIds = await CourierPayment.distinct('lines.order');
  const orders = await Order.find({ status: 'Delivered', _id: { $nin: paidOrderIds } })
    .sort({ updatedAt: 1 })
    .select('orderNumber customerName phone total status createdAt updatedAt');

  res.json({
    success: true,
    data: {
      orders,
      count: orders.length,
      expectedTotal: round2(orders.reduce((sum, order) => sum + order.total, 0))
    }
  });
});

// GET /api/courier-payments - Recorded payments, newest first, with all-time totals
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { page, limit } = listQuerySchema.parse(req.query);

  const [payments, total, totals] = await Promise.all([
    CourierPayment.find()
      .sort({ paidAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-__v'),
    CourierPayment.countDocuments(),
    CourierPayment.aggregate([
      {
        $group: {
          _id: null,
          collectedTotal: { $sum: '$collectedTotal' },
          chargeTotal: { $sum: '$chargeTotal' },
          netTotal: { $sum: '$netTotal' },
          amountReceived: { $sum: '$amountReceived' }
        }
      }
    ])
  ]);

  const sums = totals[0] ?? { collectedTotal: 0, chargeTotal: 0, netTotal: 0, amountReceived: 0 };

  res.json({
    success: true,
    data: payments,
    summary: {
      collectedTotal: round2(sums.collectedTotal),
      chargeTotal: round2(sums.chargeTotal),
      netTotal: round2(sums.netTotal),
      amountReceived: round2(sums.amountReceived)
    },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

// GET /api/courier-payments/:id - One payment with its order lines
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const payment = await CourierPayment.findById(req.params.id).select('-__v');

  if (!payment) {
    res.status(404).json({ success: false, message: 'Payment not found' });
    return;
  }

  res.json({ success: true, data: payment });
});

// POST /api/courier-payments - Record a payout from the courier's statement.
// The admin types what the statement says per parcel (cash collected, charge);
// the server looks up each order and computes every total.
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = paymentBodySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: 'Invalid payment data',
      errors: parsed.error.issues.map((issue) =>
        issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
      )
    });
    return;
  }

  const { lines, amountReceived, ...details } = parsed.data;

  const orderNumbers = lines.map((line) => line.orderNumber);
  const repeated = orderNumbers.filter((n, i) => orderNumbers.indexOf(n) !== i);
  if (repeated.length) {
    res.status(400).json({
      success: false,
      message: `Each order can be on a payment once: ${[...new Set(repeated)].join(', ')} is listed twice`
    });
    return;
  }

  const orders = await Order.find({ orderNumber: { $in: orderNumbers } }).select('orderNumber status total');
  const orderMap = new Map(orders.map((o) => [o.orderNumber, o]));

  const missing = orderNumbers.filter((n) => !orderMap.has(n));
  if (missing.length) {
    res.status(400).json({ success: false, message: `Order not found: ${missing.join(', ')}` });
    return;
  }

  const notWithCourier = orders.filter((o) => !PAYABLE_STATUSES.includes(o.status));
  if (notWithCourier.length) {
    res.status(400).json({
      success: false,
      message:
        'Only shipped, delivered or returned orders can be on a courier payment: ' +
        notWithCourier.map((o) => `${o.orderNumber} is ${o.status}`).join(', ')
    });
    return;
  }

  const alreadyPaid = await CourierPayment.find({ 'lines.order': { $in: orders.map((o) => o._id) } }).select(
    'lines.order lines.orderNumber paidAt'
  );
  if (alreadyPaid.length) {
    const ids = new Set(orders.map((o) => String(o._id)));
    const paidNumbers = alreadyPaid.flatMap((p) =>
      p.lines.filter((l) => ids.has(String(l.order))).map((l) => l.orderNumber)
    );
    res.status(409).json({
      success: false,
      message: `Already on an earlier payment: ${paidNumbers.join(', ')}`
    });
    return;
  }

  const paymentLines = lines.map((line) => {
    const order = orderMap.get(line.orderNumber)!;
    return {
      order: order._id,
      orderNumber: order.orderNumber,
      orderTotal: order.total,
      collected: line.collected,
      charge: line.charge,
      net: round2(line.collected - line.charge)
    };
  });

  const collectedTotal = round2(paymentLines.reduce((sum, l) => sum + l.collected, 0));
  const chargeTotal = round2(paymentLines.reduce((sum, l) => sum + l.charge, 0));
  const netTotal = round2(collectedTotal - chargeTotal);
  const received = amountReceived ?? netTotal;

  try {
    const payment = await CourierPayment.create({
      ...details,
      lines: paymentLines,
      collectedTotal,
      chargeTotal,
      netTotal,
      amountReceived: received,
      difference: round2(received - netTotal),
      recordedBy: req.admin?.email
    });

    res.status(201).json({
      success: true,
      data: payment,
      message: 'Courier payment recorded'
    });
  } catch (error: any) {
    // Another admin recorded one of these orders between the check above and now
    if (error.code !== 11000) throw error;
    res.status(409).json({
      success: false,
      message: 'One of these orders was just recorded on another payment — reload and try again'
    });
  }
});

// DELETE /api/courier-payments/:id - Remove a payment entered by mistake; its
// orders show as unpaid again so it can be re-entered correctly
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const payment = await CourierPayment.findByIdAndDelete(req.params.id);

  if (!payment) {
    res.status(404).json({ success: false, message: 'Payment not found' });
    return;
  }

  res.json({ success: true, message: 'Courier payment deleted' });
});

export default router;
