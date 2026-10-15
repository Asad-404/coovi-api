import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requirePermission } from '../middleware/auth';
import Order, { type IOrder } from '../models/Order';
import CourierPayment from '../models/CourierPayment';
import { DAY_MS, DAY_PATTERN, dhakaDay, isDhakaDay, startOfDhakaDay } from '../services/dhakaDays';

// GET /api/stats - The admin dashboard's numbers, worked out here from every
// order in the range (the admin's order list is paged, so the browser can't).
// Anyone with orders.view gets order counts; the money section (revenue, cost,
// profit, cash still with the courier) is only included with money.view.
const router = Router();
router.use(requireAdmin, requirePermission('orders.view'));

const MAX_DAYS = 366;

const dayString = z
  .string()
  .regex(DAY_PATTERN, 'must be a date like 2026-10-15')
  .refine(isDhakaDay, 'must be a real date');

const statsQuerySchema = z.object({
  from: dayString.optional(),
  to: dayString.optional()
});

const STATUSES: IOrder['status'][] = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Returned'];
const SOURCES: IOrder['source'][] = ['website', 'facebook', 'whatsapp', 'phone', 'other'];
// Cancelled and refused orders never bring money in
const NOT_SOLD: IOrder['status'][] = ['Cancelled', 'Returned'];

const round2 = (value: number): number => Math.round(value * 100) / 100;
const countBy = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

interface StatsOrder {
  _id: unknown;
  status: IOrder['status'];
  source?: IOrder['source'];
  deliveryArea?: string;
  district?: string;
  subtotal: number;
  discount?: number;
  deliveryFee: number;
  total: number;
  createdAt: Date;
  items: { productId: string; name: string; price: number; quantity: number; preorder?: boolean; costPrice?: number }[];
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = statsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: 'Invalid date range',
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    });
    return;
  }

  // Default: the last 30 days, today included
  const today = dhakaDay(new Date());
  const to = parsed.data.to ?? today;
  const from = parsed.data.from ?? dhakaDay(new Date(startOfDhakaDay(to).getTime() - 29 * DAY_MS));
  const start = startOfDhakaDay(from);
  const end = new Date(startOfDhakaDay(to).getTime() + DAY_MS);
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  if (days < 1 || days > MAX_DAYS) {
    res.status(400).json({
      success: false,
      message: `"from" must be on or before "to", and the range can be at most ${MAX_DAYS} days`
    });
    return;
  }

  const showMoney = req.admin?.permissions?.includes('money.view') === true;

  const [orders, pipeline] = await Promise.all([
    Order.find({ createdAt: { $gte: start, $lt: end } })
      .select('status source deliveryArea district subtotal discount deliveryFee total createdAt items.productId items.name items.price items.quantity items.preorder' + (showMoney ? ' +items.costPrice' : ''))
      .lean<StatsOrder[]>(),
    // What needs doing right now, whenever the order was placed
    Order.aggregate<{ _id: IOrder['status']; count: number; preorders: number }>([
      { $match: { status: { $in: ['Pending', 'Processing', 'Shipped'] } } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          preorders: { $sum: { $cond: [{ $in: [true, { $ifNull: ['$items.preorder', []] }] }, 1, 0] } }
        }
      }
    ])
  ]);

  const byStatus = countBy(STATUSES);
  const bySource = countBy(SOURCES);
  const byArea = { inside_dhaka: 0, outside_dhaka: 0 };
  const districts = new Map<string, number>();
  const daily = new Map<string, { date: string; orders: number; value: number }>();
  const products = new Map<string, { productId: string; name: string; quantity: number; value: number }>();
  let withPreorder = 0;

  // Every day of the range gets a bar, even days without orders
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    const date = dhakaDay(new Date(t));
    daily.set(date, { date, orders: 0, value: 0 });
  }

  const money = {
    deliveredRevenue: 0,
    deliveredOrders: 0,
    orderValue: 0,
    soldOrders: 0,
    deliveryFees: 0,
    cost: 0,
    profitRevenue: 0,
    unknownCostOrders: 0
  };

  for (const order of orders) {
    byStatus[order.status] += 1;
    bySource[order.source ?? 'website'] += 1;
    // Orders from before delivery areas were charged the inside-Dhaka fee
    byArea[order.deliveryArea === 'outside_dhaka' ? 'outside_dhaka' : 'inside_dhaka'] += 1;
    if (order.district) districts.set(order.district, (districts.get(order.district) ?? 0) + 1);
    if (order.items.some((item) => item.preorder)) withPreorder += 1;

    const day = daily.get(dhakaDay(order.createdAt));
    if (day) day.orders += 1;

    if (NOT_SOLD.includes(order.status)) continue;

    money.orderValue += order.total;
    money.soldOrders += 1;
    if (day) day.value += order.total;

    for (const item of order.items) {
      const line = products.get(item.productId) ?? { productId: item.productId, name: item.name, quantity: 0, value: 0 };
      line.quantity += item.quantity;
      line.value += item.price * item.quantity;
      products.set(item.productId, line);
    }

    if (order.status === 'Delivered') {
      money.deliveredRevenue += order.total;
      money.deliveredOrders += 1;
      money.deliveryFees += order.deliveryFee;
      // Profit needs the cost of every line; orders placed before a cost was set are counted apart
      if (order.items.every((item) => item.costPrice != null)) {
        money.cost += order.items.reduce((sum, item) => sum + item.costPrice! * item.quantity, 0);
        money.profitRevenue += order.subtotal - (order.discount ?? 0);
      } else {
        money.unknownCostOrders += 1;
      }
    }
  }

  const pipelineCount = (status: IOrder['status']) => pipeline.find((p) => p._id === status);
  const finished = byStatus.Delivered + byStatus.Returned;

  const data: Record<string, unknown> = {
    range: { from, to, days },
    orders: {
      total: orders.length,
      byStatus,
      bySource,
      byArea,
      withPreorder,
      // Of the parcels that reached the door, the share refused (Returned)
      refusedRate: finished ? round2((byStatus.Returned / finished) * 100) : null
    },
    pipeline: {
      toConfirm: pipelineCount('Pending')?.count ?? 0,
      toShip: pipelineCount('Processing')?.count ?? 0,
      onTheWay: pipelineCount('Shipped')?.count ?? 0,
      // Confirmed orders with a line still being sourced
      preordersWaiting: pipelineCount('Processing')?.preorders ?? 0
    },
    daily: [...daily.values()].map((d) => (showMoney ? { ...d, value: round2(d.value) } : { date: d.date, orders: d.orders })),
    bestSellers: [...products.values()]
      .sort((a, b) => b.quantity - a.quantity || b.value - a.value)
      .slice(0, 10)
      .map((p) => (showMoney ? { ...p, value: round2(p.value) } : { productId: p.productId, name: p.name, quantity: p.quantity })),
    topDistricts: [...districts]
      .map(([district, count]) => ({ district, orders: count }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 10)
  };

  if (showMoney) {
    // Delivered orders the courier hasn't paid out yet, from any date (same rule as /courier-payments/unpaid)
    const paidOrderIds = await CourierPayment.distinct('lines.order');
    const [owed] = await Order.aggregate<{ count: number; total: number }>([
      { $match: { status: 'Delivered', _id: { $nin: paidOrderIds } } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } }
    ]);

    data.money = {
      deliveredRevenue: round2(money.deliveredRevenue),
      deliveredOrders: money.deliveredOrders,
      // Everything not cancelled or refused, delivered or not yet
      orderValue: round2(money.orderValue),
      averageOrderValue: money.soldOrders ? round2(money.orderValue / money.soldOrders) : null,
      deliveryFees: round2(money.deliveryFees),
      // Delivered orders whose every line has a cost: item sales after discount minus cost.
      // Courier charges are not taken off (see Courier payments for those)
      cost: round2(money.cost),
      grossProfit: round2(money.profitRevenue - money.cost),
      profitOrders: money.deliveredOrders - money.unknownCostOrders,
      unknownCostOrders: money.unknownCostOrders,
      courierOwes: { orders: owed?.count ?? 0, total: round2(owed?.total ?? 0) }
    };
  }

  res.json({ success: true, data });
});

export default router;
