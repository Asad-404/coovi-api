import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requirePermission, actor } from '../middleware/auth';
import Order from '../models/Order';
import BlockedPhone from '../models/BlockedPhone';

// Checkout is guest-only, so a "customer" is a phone number: these routes add up
// that phone's orders. Seeing customers needs orders.view; blocking or unblocking a
// phone needs orders.edit. Money spent is only sent to people with money.view.
const router = Router();
router.use(requireAdmin, requirePermission('orders.view'));

const phoneSchema = z.string().regex(/^01\d{9}$/, 'phone must be 11 digits starting with 01');

// Turns typed text into a literal pattern, so "(01" can't break or bend the query
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Lenient like the other list endpoints: bad values fall back to defaults
const listQuerySchema = z.object({
  page: z.coerce.number().int().catch(1).transform((v) => Math.max(1, v)),
  limit: z.coerce.number().int().catch(25).transform((v) => Math.min(Math.max(1, v), 100)),
  search: z.string().trim().max(100).catch(''),
  sort: z.enum(['recent', 'orders', 'refused']).catch('recent'),
  blocked: z.enum(['true', 'false']).catch('false')
});

const blockBodySchema = z.strictObject({
  blocked: z.boolean(),
  note: z.string().trim().max(300).optional()
});

// Refused at the door plus cancelled: two or more and the admin calls before shipping
export const RISKY_COUNT = 2;

interface CustomerRow {
  phone: string;
  name: string;
  address: string;
  district?: string;
  orders: number;
  delivered: number;
  cancelled: number;
  returned: number;
  spent: number;
  firstOrderAt: Date;
  lastOrderAt: Date;
}

// One row per phone, newest name and address first (sorted before grouping)
const GROUP_BY_PHONE = [
  { $sort: { createdAt: -1 as const } },
  {
    $group: {
      _id: '$phone',
      name: { $first: '$customerName' },
      address: { $first: '$address' },
      district: { $first: '$district' },
      orders: { $sum: 1 },
      delivered: { $sum: { $cond: [{ $eq: ['$status', 'Delivered'] }, 1, 0] } },
      cancelled: { $sum: { $cond: [{ $eq: ['$status', 'Cancelled'] }, 1, 0] } },
      returned: { $sum: { $cond: [{ $eq: ['$status', 'Returned'] }, 1, 0] } },
      // Money that actually came in: delivered orders only
      spent: { $sum: { $cond: [{ $eq: ['$status', 'Delivered'] }, '$total', 0] } },
      firstOrderAt: { $last: '$createdAt' },
      lastOrderAt: { $first: '$createdAt' }
    }
  },
  { $project: { _id: 0, phone: '$_id', name: 1, address: 1, district: 1, orders: 1, delivered: 1, cancelled: 1, returned: 1, spent: 1, firstOrderAt: 1, lastOrderAt: 1 } }
];

const SORTS = {
  recent: { lastOrderAt: -1, phone: 1 },
  orders: { orders: -1, lastOrderAt: -1, phone: 1 },
  refused: { problems: -1, lastOrderAt: -1, phone: 1 }
} as const;

const showsMoney = (req: Request): boolean => req.admin?.permissions?.includes('money.view') === true;

const toCustomer = (row: CustomerRow, block: { note?: string; by: string; createdAt: Date } | undefined, money: boolean) => {
  const { spent, ...rest } = row;
  return {
    ...rest,
    ...(money && { spent }),
    risky: row.returned + row.cancelled >= RISKY_COUNT,
    blocked: block ? { note: block.note, by: block.by, at: block.createdAt } : null
  };
};

const blocksFor = async (phones: string[]) => {
  const blocks = await BlockedPhone.find({ phone: { $in: phones } }).lean();
  return new Map(blocks.map((b) => [b.phone, b]));
};

// GET /api/customers - Customers (phones) with their order counts, paged
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { page, limit, search, sort, blocked } = listQuerySchema.parse(req.query);

  const match: Record<string, unknown> = {};
  if (search) {
    const pattern = { $regex: escapeRegex(search), $options: 'i' };
    match.$or = [{ phone: pattern }, { customerName: pattern }];
  }
  if (blocked === 'true') {
    match.phone = { $in: await BlockedPhone.distinct('phone') };
  }

  const [result] = await Order.aggregate<{ rows: CustomerRow[]; total: { count: number }[] }>([
    { $match: match },
    ...GROUP_BY_PHONE,
    { $addFields: { problems: { $add: ['$returned', '$cancelled'] } } },
    { $sort: SORTS[sort] },
    {
      $facet: {
        rows: [{ $skip: (page - 1) * limit }, { $limit: limit }, { $project: { problems: 0 } }],
        total: [{ $count: 'count' }]
      }
    }
  ]);

  const rows = result?.rows ?? [];
  const total = result?.total[0]?.count ?? 0;
  const blocks = await blocksFor(rows.map((r) => r.phone));
  const money = showsMoney(req);

  res.json({
    success: true,
    data: rows.map((row) => toCustomer(row, blocks.get(row.phone), money)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

// GET /api/customers/:phone - One phone's totals and its latest 50 orders.
// The admin's order window calls this to show "4 earlier orders: 2 refused".
router.get('/:phone', async (req: Request, res: Response): Promise<void> => {
  const phone = phoneSchema.safeParse(req.params.phone);
  if (!phone.success) {
    res.status(400).json({ success: false, message: 'phone must be 11 digits starting with 01' });
    return;
  }

  const [[row], orders, block] = await Promise.all([
    Order.aggregate<CustomerRow>([{ $match: { phone: phone.data } }, ...GROUP_BY_PHONE]),
    Order.find({ phone: phone.data })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('orderNumber customerName status total createdAt'),
    BlockedPhone.findOne({ phone: phone.data }).lean()
  ]);

  if (!row && !block) {
    res.status(404).json({ success: false, message: 'No orders from this phone' });
    return;
  }

  // A phone blocked before it ever ordered has no totals yet
  const totals: CustomerRow = row ?? {
    phone: phone.data,
    name: '',
    address: '',
    orders: 0,
    delivered: 0,
    cancelled: 0,
    returned: 0,
    spent: 0,
    firstOrderAt: block!.createdAt,
    lastOrderAt: block!.createdAt
  };
  res.json({
    success: true,
    data: { customer: toCustomer(totals, block ?? undefined, showsMoney(req)), orders }
  });
});

// PUT /api/customers/:phone/block - { blocked, note? }. Blocking keeps accepting the
// phone's orders but shows them in red in the admin; unblocking removes the mark.
router.put('/:phone/block', requirePermission('orders.edit'), async (req: Request, res: Response): Promise<void> => {
  const phone = phoneSchema.safeParse(req.params.phone);
  const body = blockBodySchema.safeParse(req.body);
  if (!phone.success || !body.success) {
    res.status(400).json({
      success: false,
      message: 'Invalid block request',
      errors: [...(phone.error?.issues ?? []), ...(body.error?.issues ?? [])].map((issue) =>
        issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
      )
    });
    return;
  }

  if (!body.data.blocked) {
    await BlockedPhone.deleteOne({ phone: phone.data });
    res.json({ success: true, data: { phone: phone.data, blocked: null }, message: 'Phone unblocked' });
    return;
  }

  const { by, byId } = actor(req);
  const block = await BlockedPhone.findOneAndUpdate(
    { phone: phone.data },
    // Re-blocking replaces the note; leaving it out clears it
    body.data.note ? { $set: { note: body.data.note, by, byId } } : { $set: { by, byId }, $unset: { note: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  ).lean();

  res.json({
    success: true,
    data: { phone: phone.data, blocked: { note: block!.note, by: block!.by, at: block!.createdAt } },
    message: 'Phone blocked'
  });
});

export default router;
