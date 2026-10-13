import { randomInt } from 'node:crypto';
import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { actor, requireAdmin } from '../middleware/auth';
import { orderLimiter, orderLookupLimiter, readLimiter } from '../middleware/rateLimiters';
import Order, { type IOrder } from '../models/Order';
import Product from '../models/Product';
import { notifyNewOrder } from '../services/notify';

const router = Router();

// Admin-only fields. Every response a customer can see (placing an order,
// public tracking) leaves these out; the admin routes return everything.
export const PRIVATE_ORDER_FIELDS = ['internalNotes', 'statusHistory', 'editHistory'] as const;
const PUBLIC_ORDER_SELECT = ['-__v', ...PRIVATE_ORDER_FIELDS.map((f) => `-${f}`)].join(' ');

const toPublicOrder = (order: IOrder) => {
  const data: Record<string, unknown> = order.toObject();
  delete data.__v;
  for (const field of PRIVATE_ORDER_FIELDS) delete data[field];
  return data;
};

// Order number + phone are a guest's only credentials for viewing an order, so
// the random part must be unguessable: 6 characters from a 30-letter alphabet
// (no look-alikes 0/O, 1/I/L, and no U) is ~729 million per day, drawn with a
// cryptographic RNG. The date is the shop's day in Bangladesh (UTC+6), not UTC.
const ORDER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const ORDER_CODE_LENGTH = 6;

export const generateOrderNumber = (now: Date = new Date()): string => {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .format(now)
    .replace(/-/g, '');
  let code = '';
  for (let i = 0; i < ORDER_CODE_LENGTH; i++) {
    code += ORDER_CODE_ALPHABET[randomInt(ORDER_CODE_ALPHABET.length)];
  }
  return `ORD-${date}-${code}`;
};

// Guest phone, same rule as checkout. Shared with the lookup so the query can
// only ever be one plain phone string.
const phoneSchema = z.string().regex(/^01\d{9}$/, 'phone must be 11 digits starting with 01');

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
  phone: phoneSchema,
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

  // The unique orderNumber index can (very rarely) reject a random collision —
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
        status: 'Pending',
        statusHistory: [{ to: 'Pending', by: 'customer', at: new Date() }]
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
    data: toPublicOrder(order),
    message: 'Order placed successfully'
  });

  // Alert the owner after the customer has their answer; notifyNewOrder never throws
  void notifyNewOrder(order);
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

// ?updatedSince=<ISO time> asks only for orders created or changed at or after that time,
// so the admin can keep its list fresh without downloading every order each minute.
// Unlike the lenient fields above, a bad time is a 400: silently ignoring it would
// return the whole list and hide the client's bug.
const updatedSinceSchema = z.iso.datetime({ offset: true }).optional();

// GET /api/orders - Get all orders (Admin only - JWT required)
router.get('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { page, limit, status } = orderListQuerySchema.parse(req.query);
  const skip = (page - 1) * limit;
  // Taken before the query: the client asks "changed since serverTime" next time, so a
  // change landing while this request runs is picked up then instead of being missed
  const serverTime = new Date().toISOString();

  const since = updatedSinceSchema.safeParse(req.query.updatedSince);
  if (!since.success) {
    res.status(400).json({
      success: false,
      message: 'updatedSince must be an ISO date-time, e.g. 2026-10-13T07:45:00.000Z'
    });
    return;
  }

  const query: { status?: OrderStatus; updatedAt?: { $gte: Date } } = {};
  if (status) {
    query.status = status;
  }
  if (since.data) {
    query.updatedAt = { $gte: new Date(since.data) };
  }

  // Execute query (changes come oldest first so paging through them is stable)
  const orders = await Order.find(query)
    .sort(since.data ? { updatedAt: 1, _id: 1 } : { createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .select('-__v');

  const total = await Order.countDocuments(query);

  res.json({
    success: true,
    data: orders,
    serverTime,
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

  if (req.query.phone === undefined) {
    res.status(400).json({
      success: false,
      message: 'Phone number is required to view an order'
    });
    return;
  }

  // Exactly one well-formed phone. Repeated ?phone=a&phone=b arrives as an
  // array, which Mongoose would turn into "phone is a OR b" and let one request
  // try many phones; ?phone[$ne]=x arrives as an object. Both are refused here.
  const phone = phoneSchema.safeParse(req.query.phone);
  if (!phone.success) {
    res.status(400).json({
      success: false,
      message: 'Send one phone number: 11 digits starting with 01'
    });
    return;
  }

  const order = await Order.findOne({ orderNumber, phone: phone.data }).select(PUBLIC_ORDER_SELECT);

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
    phone: phoneSchema.optional(),
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

  const current = await Order.findOne({ _id: req.params.id, status: { $nin: FINAL_STATUSES } })
    .select('customerName phone address notes')
    .lean();

  // Keep a before/after record of every field that really changes
  const fields = Object.keys(parsed.data) as (keyof typeof parsed.data)[];
  const changes = current
    ? fields
        .filter((field) => (current[field] ?? '') !== (parsed.data[field] ?? ''))
        .map((field) => ({ field, from: current[field], to: parsed.data[field] }))
    : [];

  // The filter also matches the values just read, so an edit made by someone
  // else in between can't end up recorded with the wrong "from" value
  const order = current
    ? await Order.findOneAndUpdate(
        {
          _id: req.params.id,
          status: { $nin: FINAL_STATUSES },
          ...Object.fromEntries(changes.map((c) => [c.field, c.from ?? { $exists: false }]))
        },
        {
          $set: parsed.data,
          ...(changes.length && { $push: { editHistory: { changes, ...actor(req), at: new Date() } } })
        },
        { returnDocument: 'after', runValidators: true }
      ).select('-__v')
    : null;

  if (!order && current) {
    res.status(409).json({
      success: false,
      message: 'This order was just changed by someone else — reload and try again'
    });
    return;
  }

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
  // The history entry is written in the same update, so a status change and
  // its record can never disagree.
  const historyId = new Types.ObjectId();
  const order = await Order.findOneAndUpdate(
    { _id: id, status: oldStatus },
    {
      $set: { status },
      $push: { statusHistory: { _id: historyId, from: oldStatus, to: status, ...actor(req), at: new Date() } }
    },
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
        await Order.updateOne(
          { _id: id, status },
          { $set: { status: oldStatus }, $pull: { statusHistory: { _id: historyId } } }
        );

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

const noteBodySchema = z.object({ text: z.string().trim().min(1).max(500) });

// POST /api/orders/:id/notes - Add a private note (Admin only - JWT required).
// Allowed at any status: a call after delivery about a return still needs writing down.
router.post('/:id/notes', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const parsed = noteBodySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: 'Note must be 1 to 500 characters'
    });
    return;
  }

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { $push: { internalNotes: { text: parsed.data.text, ...actor(req), at: new Date() } } },
    { returnDocument: 'after' }
  ).select('-__v');

  if (!order) {
    res.status(404).json({
      success: false,
      message: 'Order not found'
    });
    return;
  }

  res.status(201).json({
    success: true,
    data: order,
    message: 'Note added'
  });
});

export default router;
