import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import type { QueryFilter } from 'mongoose';
import { z } from 'zod';
import { actor, requireAdmin } from '../middleware/auth';
import { orderLimiter, orderLookupLimiter, readLimiter } from '../middleware/rateLimiters';
import Order, { type IOrder } from '../models/Order';
import Product from '../models/Product';
import {
  DELIVERY_AREAS,
  DISTRICTS,
  getDeliveryFee,
  getDeliveryFees,
  resolveDeliveryArea
} from '../services/deliveryFees';
import { buildOrderItems, createOrderWithNumber } from '../services/orderPricing';
import { alertNewOrder } from '../services/notify';

// Re-exported so tests keep importing it from the route
export { generateOrderNumber } from '../services/orderPricing';

const router = Router();

// Admin-only fields. Every response a customer can see (placing an order,
// public tracking) leaves these out; the admin routes return everything.
// createdBy is the email an admin signs in with, so a customer must never see it.
export const PRIVATE_ORDER_FIELDS = ['internalNotes', 'statusHistory', 'editHistory', 'cancelReason', 'restocked', 'createdBy'] as const;
const PUBLIC_ORDER_SELECT = ['-__v', ...PRIVATE_ORDER_FIELDS.map((f) => `-${f}`)].join(' ');

const toPublicOrder = (order: IOrder) => {
  const data: Record<string, unknown> = order.toObject();
  delete data.__v;
  for (const field of PRIVATE_ORDER_FIELDS) delete data[field];
  return data;
};

// Guest phone, same rule as checkout. Shared with the lookup so the query can
// only ever be one plain phone string.
const phoneSchema = z.string().regex(/^01\d{9}$/, 'phone must be 11 digits starting with 01');

// The order body deliberately accepts ONLY quantities (CC-1: never trust the
// browser). NOT a strictObject on purpose: a client that still sends prices or
// totals gets them silently DROPPED, not rejected — the API simply never reads
// them, so a spoofed "total: 1" can't be stored no matter what the client sends.
const orderBodySchema = z.object({
  customerName: z.string().min(1).max(100),
  phone: phoneSchema,
  address: z.string().min(5).max(500),
  // Optional so an older storefront that sends neither still works (inside Dhaka)
  district: z.enum(DISTRICTS).optional(),
  deliveryArea: z.enum(DELIVERY_AREAS).optional(),
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

  const { customerName, phone, address, district, notes, items } = parsed.data;

  const resolved = resolveDeliveryArea(district, parsed.data.deliveryArea);
  if ('error' in resolved) {
    res.status(400).json({ success: false, message: 'Invalid order data', errors: [`deliveryArea: ${resolved.error}`] });
    return;
  }
  const deliveryArea = resolved.area;

  // Recompute EVERYTHING server-side (CC-1); the fee comes from the area (CC-3)
  const built = await buildOrderItems(items);

  if (!built.ok) {
    res.status(400).json({ success: false, message: built.message });
    return;
  }

  const { items: orderItems, subtotal } = built;
  const deliveryFee = await getDeliveryFee(deliveryArea);
  const total = subtotal + deliveryFee;

  const order = await createOrderWithNumber({
    customerName,
    phone,
    address,
    district,
    deliveryArea,
    notes,
    items: orderItems,
    subtotal,
    deliveryFee,
    total,
    paymentMethod: 'Cash on Delivery',
    status: 'Pending',
    statusHistory: [{ to: 'Pending', by: 'customer', at: new Date() }]
  });

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

  // Alert the owner after the customer has their answer; alertNewOrder never throws
  // and groups orders that arrive close together into one email
  void alertNewOrder(order);
});

export const ORDER_SOURCES = ['facebook', 'whatsapp', 'phone', 'other'] as const;

// An order an admin types in for a customer who ordered by Facebook, WhatsApp
// or phone. Same items-and-quantities body as checkout, so prices still come
// from the database; the admin may also agree a delivery fee and a taka
// discount with the customer. strictObject: a client sending price or total
// fields gets a 400 instead of believing it set them.
const manualOrderSchema = z.strictObject({
  ...orderBodySchema.shape,
  source: z.enum(ORDER_SOURCES),
  deliveryFeeOverride: z.number().int().min(0).max(10000).optional(),
  discount: z.number().int().min(0).optional()
});

// POST /api/orders/manual - Enter an order taken outside the website (Admin only - JWT required)
// Not rate-limited like checkout: the admin is trusted and may enter many orders in a row.
router.post('/manual', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const parsed = manualOrderSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: 'Invalid order data',
      errors: parsed.error.issues.map((issue) =>
        issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
      )
    });
    return;
  }

  const { customerName, phone, address, district, notes, items, source, deliveryFeeOverride, discount = 0 } = parsed.data;

  const resolved = resolveDeliveryArea(district, parsed.data.deliveryArea);
  if ('error' in resolved) {
    res.status(400).json({ success: false, message: 'Invalid order data', errors: [`deliveryArea: ${resolved.error}`] });
    return;
  }
  const deliveryArea = resolved.area;

  const built = await buildOrderItems(items);

  if (!built.ok) {
    res.status(400).json({ success: false, message: built.message });
    return;
  }

  const { items: orderItems, subtotal } = built;

  // The discount comes off the sarees, never the delivery fee, so the total can't go below the fee
  if (discount > subtotal) {
    res.status(400).json({
      success: false,
      message: `Discount (${discount}) can't be more than the items subtotal (${subtotal})`
    });
    return;
  }

  const deliveryFee = deliveryFeeOverride ?? (await getDeliveryFee(deliveryArea));
  const total = subtotal - discount + deliveryFee;

  // Created as Pending like a website order: confirming it (Pending → Processing)
  // takes the stock through the same path as every other order
  const order = await createOrderWithNumber({
    customerName,
    phone,
    address,
    district,
    deliveryArea,
    notes,
    items: orderItems,
    subtotal,
    discount,
    deliveryFee,
    total,
    paymentMethod: 'Cash on Delivery',
    status: 'Pending',
    source,
    createdBy: req.admin?.email,
    statusHistory: [{ to: 'Pending', ...actor(req), at: new Date() }]
  });

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
    message: 'Order added successfully'
  });
});

type OrderStatus = IOrder['status'];

const ORDER_STATUSES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Returned'] as const;

// Same lenient query handling as GET /api/products: bad values fall back to
// defaults instead of erroring (a negative page used to reach Mongo as a negative skip)
const orderListQuerySchema = z.object({
  page: z.coerce.number().int().catch(1).transform((v) => Math.max(1, v)),
  limit: z.coerce.number().int().catch(20).transform((v) => Math.min(Math.max(1, v), 100)),
  status: z.enum(ORDER_STATUSES).optional().catch(undefined),
  deliveryArea: z.enum(DELIVERY_AREAS).optional().catch(undefined)
});

// ?updatedSince=<ISO time> asks only for orders created or changed at or after that time,
// so the admin can keep its list fresh without downloading every order each minute.
// Unlike the lenient fields above, a bad time is a 400: silently ignoring it would
// return the whole list and hide the client's bug.
const updatedSinceSchema = z.iso.datetime({ offset: true }).optional();

// GET /api/orders - Get all orders (Admin only - JWT required)
router.get('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { page, limit, status, deliveryArea } = orderListQuerySchema.parse(req.query);
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

  const query: QueryFilter<IOrder> = {};
  if (status) {
    query.status = status;
  }
  if (deliveryArea) {
    // Orders from before delivery areas have no field and were charged the inside-Dhaka fee
    query.deliveryArea = deliveryArea === 'inside_dhaka' ? { $in: ['inside_dhaka', null] } : deliveryArea;
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
// before the customer places the order — these are the same server-side values
// that will be charged, so the number can never disagree with the API.
// `deliveryFee` (inside Dhaka) stays for older clients; `zones` has every area
// and `districts` is the list checkout offers.
// Must be registered BEFORE GET /:orderNumber, or "delivery-fee" would be
// captured as an orderNumber.
router.get('/delivery-fee', readLimiter, async (_req: Request, res: Response): Promise<void> => {
  const zones = await getDeliveryFees();
  res.json({
    success: true,
    data: { deliveryFee: zones.inside_dhaka, zones, districts: DISTRICTS }
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
// back on Processing → Cancelled or on Shipped → Returned (the customer refused
// the parcel at the door). Every other jump (back to Pending, cancelling after
// shipping, reopening a delivered order) would take or return stock twice or
// not at all, so it is refused. Customers check the saree in front of the rider,
// so the shop does not take returns after delivery: Delivered is final.
export const NEXT_STATUSES: Record<OrderStatus, OrderStatus[]> = {
  Pending: ['Processing', 'Cancelled'],
  Processing: ['Shipped', 'Cancelled'],
  Shipped: ['Delivered', 'Returned'],
  Delivered: [],
  Cancelled: [],
  Returned: []
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
    notes: z.string().trim().max(500).optional(),
    district: z.enum(DISTRICTS).optional(),
    deliveryArea: z.enum(DELIVERY_AREAS).optional()
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to update');

// Delivered, Cancelled and Returned orders are history — their details are frozen
const FINAL_STATUSES: OrderStatus[] = ['Delivered', 'Cancelled', 'Returned'];

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

  const { district, deliveryArea, ...contact } = parsed.data;
  const update: Record<string, unknown> = { ...contact };
  // Changing where the parcel goes can change the fee, so it is only allowed
  // before the order is confirmed; the API recomputes the fee and total.
  const changesDelivery = district !== undefined || deliveryArea !== undefined;

  const current = await Order.findById(req.params.id)
    .select('status customerName phone address notes district deliveryArea subtotal discount deliveryFee total')
    .lean();
  if (!current) {
    res.status(404).json({ success: false, message: 'Order not found' });
    return;
  }
  if (changesDelivery && current.status !== 'Pending') {
    res.status(409).json({ success: false, message: 'The delivery area can only be changed while the order is Pending' });
    return;
  }
  if (FINAL_STATUSES.includes(current.status)) {
    res.status(409).json({ success: false, message: 'Delivered, cancelled or returned orders can no longer be edited' });
    return;
  }

  if (changesDelivery) {
    const newDistrict = district ?? current.district;
    // A new non-Dhaka district decides the area on its own; otherwise keep the current one
    const requestedArea = deliveryArea ?? (district !== undefined ? undefined : current.deliveryArea);
    const resolved = resolveDeliveryArea(newDistrict, requestedArea);
    if ('error' in resolved) {
      res.status(400).json({ success: false, message: 'Invalid order details', errors: [`deliveryArea: ${resolved.error}`] });
      return;
    }

    update.district = newDistrict;
    update.deliveryArea = resolved.area;
    // Same area: the fee charged at checkout stands, even if the fee setting moved since
    if (resolved.area !== (current.deliveryArea ?? 'inside_dhaka')) {
      update.deliveryFee = await getDeliveryFee(resolved.area);
      // A manual order's agreed discount stays; an agreed delivery fee is replaced by the area's fee
      update.total = current.subtotal - (current.discount ?? 0) + (update.deliveryFee as number);
    }
  }

  // Keep a before/after record of every field that really changes,
  // including a delivery fee and total the API recomputed
  const before = current as unknown as Record<string, unknown>;
  const text = (value: unknown) => (value === undefined || value === null ? undefined : String(value));
  const changes = Object.keys(update)
    .filter((field) => (text(before[field]) ?? '') !== (text(update[field]) ?? ''))
    .map((field) => ({ field, from: text(before[field]), to: text(update[field]) }));

  // The filter also matches the status and the values just read, so a change
  // made by someone else in between gets a 409 instead of a wrong "from" value
  const order = await Order.findOneAndUpdate(
    {
      _id: req.params.id,
      status: current.status,
      ...Object.fromEntries(changes.map((c) => [c.field, before[c.field] ?? { $exists: false }]))
    },
    {
      $set: update,
      ...(changes.length && { $push: { editHistory: { changes, ...actor(req), at: new Date() } } })
    },
    { returnDocument: 'after', runValidators: true }
  ).select('-__v');

  if (!order) {
    res.status(409).json({
      success: false,
      message: 'This order was just changed by someone else — reload and try again'
    });
    return;
  }

  res.json({
    success: true,
    data: order,
    message: 'Order updated successfully'
  });
});

// Returns an error message when the extra fields don't fit the transition
function checkStatusExtras(status: OrderStatus, body: { reason?: string; restock?: boolean }): string | null {
  if (status === 'Returned' && !body.reason) {
    return 'Say why the parcel came back (reason is required for Returned)';
  }
  if (body.reason && status !== 'Cancelled' && status !== 'Returned') {
    return 'A reason can only be given when cancelling or returning an order';
  }
  if (body.restock !== undefined && status !== 'Returned') {
    return 'restock only applies to Returned';
  }
  return null;
}

// reason: why an order is cancelled or a parcel came back (required for Returned).
// restock: whether a returned parcel goes back on sale (default yes; untick it
// when the saree came back damaged).
const statusBodySchema = z.object({
  status: z.enum(ORDER_STATUSES),
  reason: z.string().trim().min(1).max(300).optional(),
  restock: z.boolean().optional()
});

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

  const { status, reason, restock = true } = parsed.data;
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

  const extraError = checkStatusExtras(status, parsed.data);
  if (extraError) {
    res.status(400).json({
      success: false,
      message: extraError
    });
    return;
  }

  const changes: Record<string, unknown> = { status };
  if (status === 'Cancelled' && reason) changes.cancelReason = reason;
  if (status === 'Returned') {
    changes.cancelReason = reason;
    changes.returnedAt = new Date();
    changes.restocked = restock;
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
      $set: changes,
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

  // Cancelling a confirmed order puts its stock back, and so does a refused
  // parcel unless the admin said it can't be sold again. Every order that
  // reaches Shipped went through Processing, so its stock was taken.
  // Pre-order lines took none, so they give none back.
  const returnsStock =
    (oldStatus === 'Processing' && status === 'Cancelled') || (status === 'Returned' && restock);
  if (returnsStock) {
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
