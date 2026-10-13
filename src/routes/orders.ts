import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth';
import { orderLimiter, orderLookupLimiter, readLimiter } from '../middleware/rateLimiters';
import Order, { type IOrder } from '../models/Order';
import Product from '../models/Product';
import {
  createSteadfastParcel,
  getSteadfastStatus,
  SteadfastError,
  SteadfastNotConfiguredError
} from '../services/steadfast';

const router = Router();

// Generate order number
const generateOrderNumber = (): string => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `ORD-${year}${month}${day}-${random}`;
};

// Delivery fee is SERVER-side config (.env DELIVERY_FEE) — the client never
// decides what it pays. Read at call time so tests and deploys can change it.
const getDeliveryFee = (): number => {
  const fee = Number(process.env.DELIVERY_FEE);
  return Number.isFinite(fee) && fee >= 0 ? fee : 60;
};

// The order body deliberately accepts ONLY quantities (CC-1: never trust the
// browser). NOT a strictObject on purpose: a client that still sends prices or
// totals gets them silently DROPPED, not rejected — the API simply never reads
// them, so a spoofed "total: 1" can't be stored no matter what the client sends.
const orderBodySchema = z.object({
  customerName: z.string().min(1).max(100),
  phone: z.string().regex(/^01\d{9}$/, 'phone must be 11 digits starting with 01'),
  address: z.string().min(5).max(500),
  notes: z.string().max(500).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().min(1).max(99)
      })
    )
    .min(1)
    .max(50)
});

// POST /api/orders - Create new order
router.post('/', orderLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = orderBodySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: 'Invalid order data',
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    });
    return;
  }

  const { customerName, phone, address, notes, items } = parsed.data;

  // Load the REAL products from the DB — source of truth for price, name, image
  const productIds = items.map((item) => item.productId);
  const products = await Product.find({ _id: { $in: productIds } }).select('name price stock inStock images size allowPreorder preorderDays');
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  for (const item of items) {
    const product = productMap.get(item.productId);

    if (!product) {
      res.status(400).json({
        success: false,
        message: `Item is no longer available (product ${item.productId})`
      });
      return;
    }

    // The admin's "Available for sale" switch (inStock) takes a product off sale even while units remain
    if (!product.inStock) {
      res.status(400).json({
        success: false,
        message: `"${product.name}" is currently unavailable`
      });
      return;
    }

    // Not enough stock: a pre-order product takes the whole line as a pre-order instead
    if (product.stock < item.quantity && !product.allowPreorder) {
      res.status(400).json({
        success: false,
        message: `Only ${product.stock} left of "${product.name}" — you asked for ${item.quantity}`
      });
      return;
    }
  }

  // Recompute EVERYTHING server-side (CC-1) with the delivery fee from env (CC-3)
  const orderItems = items.map((item) => {
    const product = productMap.get(item.productId)!;
    const preorder = product.stock < item.quantity;
    return {
      productId: item.productId,
      name: product.name,
      price: product.price,
      quantity: item.quantity,
      image: product.images[0],
      size: product.size,
      preorder,
      ...(preorder && { preorderDays: product.preorderDays })
    };
  });

  const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const deliveryFee = getDeliveryFee();
  const total = subtotal + deliveryFee;

  // The unique orderNumber index can reject a random collision (1-in-1000/day) —
  // generating a fresh number and retrying is friendlier than erroring
  let order = null;
  for (let attempt = 0; attempt < 3 && !order; attempt++) {
    try {
      order = await Order.create({
        orderNumber: generateOrderNumber(),
        customerName,
        phone,
        address,
        notes,
        items: orderItems,
        subtotal,
        deliveryFee,
        total,
        paymentMethod: 'Cash on Delivery',
        status: 'Pending'
      });
    } catch (error: any) {
      if (error.code !== 11000) throw error;
    }
  }

  if (!order) {
    res.status(500).json({
      success: false,
      message: 'Could not generate a unique order number, please try again'
    });
    return;
  }

  res.status(201).json({
    success: true,
    data: order,
    message: 'Order placed successfully'
  });
});

type OrderStatus = IOrder['status'];

const ORDER_STATUSES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'] as const;

// Same lenient query handling as GET /api/products: bad values fall back to
// defaults instead of erroring (a negative page used to reach Mongo as a negative skip)
const orderListQuerySchema = z.object({
  page: z.coerce.number().int().catch(1).transform((v) => Math.max(1, v)),
  limit: z.coerce.number().int().catch(20).transform((v) => Math.min(Math.max(1, v), 100)),
  status: z.enum(ORDER_STATUSES).optional().catch(undefined)
});

// GET /api/orders - Get all orders (Admin only - JWT required)
router.get('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { page, limit, status } = orderListQuerySchema.parse(req.query);
  const skip = (page - 1) * limit;

  const query: { status?: OrderStatus } = {};
  if (status) {
    query.status = status;
  }

  // Execute query
  const orders = await Order.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .select('-__v');

  const total = await Order.countDocuments(query);

  res.json({
    success: true,
    data: orders,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

// GET /api/orders/delivery-fee - The checkout page needs to SHOW the fee
// before the customer places the order — this is the same server-side value
// that will be charged, so the number can never disagree with the API.
// Must be registered BEFORE GET /:orderNumber, or "delivery-fee" would be
// captured as an orderNumber.
router.get('/delivery-fee', readLimiter, (_req: Request, res: Response): void => {
  res.json({
    success: true,
    data: { deliveryFee: getDeliveryFee() }
  });
});

// GET /api/orders/:orderNumber?phone=... - Get single order (public, but the
// order number ALONE must not be enough: number + phone together act as the
// guest's credentials. A wrong phone gets the same 404 as a nonexistent order
// so nobody can probe which order numbers exist.)
router.get('/:orderNumber', orderLookupLimiter, async (req: Request, res: Response): Promise<void> => {
  const { orderNumber } = req.params;
  const phone = req.query.phone as string | undefined;

  if (!phone) {
    res.status(400).json({
      success: false,
      message: 'Phone number is required to view an order'
    });
    return;
  }

  const order = await Order.findOne({ orderNumber, phone }).select('-__v -courier.bookingStartedAt');

  if (!order) {
    res.status(404).json({
      success: false,
      message: 'Order not found'
    });
    return;
  }

  res.json({
    success: true,
    data: order
  });
});

// Orders only move forward. Stock is taken on Pending → Processing and given
// back on Processing → Cancelled; every other jump (back to Pending, cancelling
// after shipping, reopening a delivered order) would take or return stock twice
// or not at all, so it is refused.
export const NEXT_STATUSES: Record<OrderStatus, OrderStatus[]> = {
  Pending: ['Processing', 'Cancelled'],
  Processing: ['Shipped', 'Cancelled'],
  Shipped: ['Delivered'],
  Delivered: [],
  Cancelled: []
};

// Admin can correct contact/delivery details after a customer calls. Items,
// prices and totals are NOT editable here — they stay server-computed (CC-1).
// strictObject: anything else in the body is a 400, not silently ignored, so an
// admin client can never believe it changed a total.
const orderDetailsSchema = z
  .strictObject({
    customerName: z.string().trim().min(1).max(100).optional(),
    phone: z.string().regex(/^01\d{9}$/, 'phone must be 11 digits starting with 01').optional(),
    address: z.string().trim().min(5).max(500).optional(),
    notes: z.string().trim().max(500).optional()
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to update');

// Delivered and Cancelled orders are history — their details are frozen
const FINAL_STATUSES: OrderStatus[] = ['Delivered', 'Cancelled'];

// PATCH /api/orders/:id - Edit customer/delivery details (Admin only - JWT required)
router.patch('/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const parsed = orderDetailsSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: 'Invalid order details',
      errors: parsed.error.issues.map((issue) =>
        issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
      )
    });
    return;
  }

  const order = await Order.findOneAndUpdate(
    { _id: req.params.id, status: { $nin: FINAL_STATUSES } },
    { $set: parsed.data },
    { returnDocument: 'after', runValidators: true }
  ).select('-__v');

  if (!order) {
    const exists = await Order.exists({ _id: req.params.id });
    res.status(exists ? 409 : 404).json({
      success: false,
      message: exists ? 'Delivered or cancelled orders can no longer be edited' : 'Order not found'
    });
    return;
  }

  res.json({
    success: true,
    data: order,
    message: 'Order updated successfully'
  });
});

const statusBodySchema = z.object({ status: z.enum(ORDER_STATUSES) });

// PATCH /api/orders/:id/status - Update order status (Admin only - JWT required)
router.patch('/:id/status', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const parsed = statusBodySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: 'Invalid status'
    });
    return;
  }

  const { status } = parsed.data;
  const current = await Order.findById(id).select('status');

  if (!current) {
    res.status(404).json({
      success: false,
      message: 'Order not found'
    });
    return;
  }

  const oldStatus = current.status;

  if (!NEXT_STATUSES[oldStatus].includes(status)) {
    const allowed = NEXT_STATUSES[oldStatus];
    res.status(409).json({
      success: false,
      message:
        oldStatus === status
          ? `Order is already ${status}`
          : `Can't move an order from ${oldStatus} to ${status}` +
            (allowed.length ? ` (allowed: ${allowed.join(', ')})` : ` — ${oldStatus} is final`)
    });
    return;
  }

  // Claim the transition atomically: the filter only matches while the order
  // is still in oldStatus, so two admins clicking at once can't both take (or
  // both return) the stock — the second one gets a 409.
  const order = await Order.findOneAndUpdate(
    { _id: id, status: oldStatus },
    { $set: { status } },
    { returnDocument: 'after' }
  ).select('-__v');

  if (!order) {
    res.status(409).json({
      success: false,
      message: 'This order was just changed by someone else — reload and try again'
    });
    return;
  }

  // Confirming an order takes stock out of the shop. Each decrement is ONE
  // atomic operation that both checks and writes: the filter matches only
  // when enough stock exists, so two admins confirming overlapping orders
  // can never drive stock below zero (a plain $inc could).
  // Pre-order lines take no stock. A line whose stock ran out since the order
  // was placed (someone else bought the last piece) becomes a pre-order when
  // the product allows it, instead of blocking the confirmation.
  if (oldStatus === 'Pending' && status === 'Processing') {
    const taken: { productId: string; quantity: number }[] = [];
    const becamePreorder: { index: number; preorderDays: number }[] = [];

    for (const [index, item] of order.items.entries()) {
      if (item.preorder) continue;

      const result = await Product.updateOne(
        { _id: item.productId, stock: { $gte: item.quantity } },
        { $inc: { stock: -item.quantity } }
      );

      if (result.matchedCount === 0) {
        const product = await Product.findById(item.productId).select('name stock allowPreorder preorderDays');

        if (product?.allowPreorder) {
          becamePreorder.push({ index, preorderDays: product.preorderDays });
          continue;
        }

        // This item couldn't be taken — give back any stock taken earlier in
        // the loop and release the claim so the order is left completely untouched
        for (const t of taken) {
          await Product.updateOne({ _id: t.productId }, { $inc: { stock: t.quantity } });
        }
        await Order.updateOne({ _id: id, status }, { $set: { status: oldStatus } });

        res.status(409).json({
          success: false,
          message: `Insufficient stock for "${product?.name ?? item.name}": only ${product?.stock ?? 0} left, order needs ${item.quantity}`
        });
        return;
      }

      taken.push({ productId: String(item.productId), quantity: item.quantity });
    }

    if (becamePreorder.length) {
      const changes: Record<string, boolean | number> = {};
      for (const { index, preorderDays } of becamePreorder) {
        changes[`items.${index}.preorder`] = true;
        changes[`items.${index}.preorderDays`] = preorderDays;
        order.items[index].preorder = true;
        order.items[index].preorderDays = preorderDays;
      }
      await Order.updateOne({ _id: id }, { $set: changes });
    }
  }

  // Cancelling a confirmed order puts its stock back (pre-order lines took none)
  if (oldStatus === 'Processing' && status === 'Cancelled') {
    for (const item of order.items) {
      if (item.preorder) continue;
      await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
    }
  }

  res.json({
    success: true,
    data: order,
    message: 'Order status updated successfully'
  });
});

// Steadfast limits the delivery address to 250 characters; ours allows 500
const STEADFAST_ADDRESS_MAX = 250;

// A booking that started this long ago and never finished (server restart
// mid-call) no longer blocks a retry. Steadfast itself refuses a second parcel
// with the same invoice, so a retry can't create a duplicate.
const BOOKING_LOCK_MS = 60_000;

// Turns a Steadfast problem into the right answer for the admin
function sendCourierError(res: Response, error: unknown): void {
  if (error instanceof SteadfastNotConfiguredError) {
    res.status(503).json({ success: false, message: error.message });
    return;
  }
  if (error instanceof SteadfastError) {
    res.status(502).json({ success: false, message: error.message });
    return;
  }
  throw error;
}

// POST /api/orders/:id/courier/steadfast - Book the parcel with Steadfast (Admin only - JWT required)
// Only a confirmed (Processing) order can be booked: its stock is already
// taken and it hasn't left yet. The cash to collect is the order total the
// API computed; nothing about the parcel comes from the browser.
router.post('/:id/courier/steadfast', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const now = new Date();

  // Claim the booking atomically so two clicks (or two admins) can't book twice
  const claimed = await Order.findOneAndUpdate(
    {
      _id: id,
      status: 'Processing',
      'courier.trackingCode': { $exists: false },
      $or: [
        { 'courier.bookingStartedAt': { $exists: false } },
        { 'courier.bookingStartedAt': { $lt: new Date(now.getTime() - BOOKING_LOCK_MS) } }
      ]
    },
    { $set: { 'courier.bookingStartedAt': now } },
    { returnDocument: 'after' }
  );

  if (!claimed) {
    const order = await Order.findById(id).select('status courier');
    if (!order) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }
    res.status(409).json({
      success: false,
      message: order.courier?.trackingCode
        ? `Already booked with Steadfast (tracking code ${order.courier.trackingCode})`
        : order.status !== 'Processing'
          ? `Only Processing orders can be booked with the courier (this order is ${order.status})`
          : 'This order is being booked right now — reload in a minute'
    });
    return;
  }

  const releaseClaim = () =>
    Order.updateOne({ _id: id, 'courier.trackingCode': { $exists: false } }, { $unset: { courier: 1 } });

  if (claimed.address.length > STEADFAST_ADDRESS_MAX) {
    await releaseClaim();
    res.status(400).json({
      success: false,
      message: `Steadfast accepts addresses up to ${STEADFAST_ADDRESS_MAX} characters; this one has ${claimed.address.length}. Shorten it with Edit first.`
    });
    return;
  }

  let booking;
  try {
    booking = await createSteadfastParcel({
      invoice: claimed.orderNumber,
      recipientName: claimed.customerName,
      recipientPhone: claimed.phone,
      recipientAddress: claimed.address,
      codAmount: claimed.total,
      note: claimed.notes
    });
  } catch (error) {
    await releaseClaim();
    sendCourierError(res, error);
    return;
  }

  const order = await Order.findByIdAndUpdate(
    id,
    {
      $set: {
        courier: {
          name: 'Steadfast',
          consignmentId: booking.consignmentId,
          trackingCode: booking.trackingCode,
          status: booking.status,
          bookedAt: new Date(),
          statusCheckedAt: new Date()
        }
      }
    },
    { returnDocument: 'after' }
  ).select('-__v');

  res.status(201).json({
    success: true,
    data: order,
    message: `Booked with Steadfast, tracking code ${booking.trackingCode}`
  });
});

// POST /api/orders/:id/courier/steadfast/refresh - Ask Steadfast where the parcel is (Admin only - JWT required)
// Saves the courier's status on the order. The order's own status is NOT
// changed here: the admin still marks it Shipped or Delivered.
router.post('/:id/courier/steadfast/refresh', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const current = await Order.findById(req.params.id).select('courier');

  if (!current) {
    res.status(404).json({ success: false, message: 'Order not found' });
    return;
  }

  const consignmentId = current.courier?.consignmentId;
  if (!consignmentId) {
    res.status(409).json({ success: false, message: 'This order has not been booked with Steadfast' });
    return;
  }

  let status: string;
  try {
    status = await getSteadfastStatus(consignmentId);
  } catch (error) {
    sendCourierError(res, error);
    return;
  }

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { $set: { 'courier.status': status, 'courier.statusCheckedAt': new Date() } },
    { returnDocument: 'after' }
  ).select('-__v');

  res.json({
    success: true,
    data: order,
    message: `Steadfast status: ${status}`
  });
});

export default router;
