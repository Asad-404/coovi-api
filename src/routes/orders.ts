import { Router, Request, Response } from 'express';
import type { QueryFilter } from 'mongoose';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth';
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

// The order body deliberately accepts ONLY quantities (CC-1: never trust the
// browser). NOT a strictObject on purpose: a client that still sends prices or
// totals gets them silently DROPPED, not rejected — the API simply never reads
// them, so a spoofed "total: 1" can't be stored no matter what the client sends.
const orderBodySchema = z.object({
  customerName: z.string().min(1).max(100),
  phone: z.string().regex(/^01\d{9}$/, 'phone must be 11 digits starting with 01'),
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

  // Load the REAL products from the DB — source of truth for price, name, image
  const productIds = items.map((item) => item.productId);
  const products = await Product.find({ _id: { $in: productIds } }).select('name price stock inStock images size');
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

    if (product.stock < item.quantity) {
      res.status(400).json({
        success: false,
        message: `Only ${product.stock} left of "${product.name}" — you asked for ${item.quantity}`
      });
      return;
    }
  }

  // Recompute EVERYTHING server-side (CC-1); the fee comes from the area (CC-3)
  const orderItems = items.map((item) => {
    const product = productMap.get(item.productId)!;
    return {
      productId: item.productId,
      name: product.name,
      price: product.price,
      quantity: item.quantity,
      image: product.images[0],
      size: product.size
    };
  });

  const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const deliveryFee = await getDeliveryFee(deliveryArea);
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
        district,
        deliveryArea,
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
  status: z.enum(ORDER_STATUSES).optional().catch(undefined),
  deliveryArea: z.enum(DELIVERY_AREAS).optional().catch(undefined)
});

// GET /api/orders - Get all orders (Admin only - JWT required)
router.get('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { page, limit, status, deliveryArea } = orderListQuerySchema.parse(req.query);
  const skip = (page - 1) * limit;

  const query: QueryFilter<IOrder> = {};
  if (status) {
    query.status = status;
  }
  if (deliveryArea) {
    // Orders from before delivery areas have no field and were charged the inside-Dhaka fee
    query.deliveryArea = deliveryArea === 'inside_dhaka' ? { $in: ['inside_dhaka', null] } : deliveryArea;
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
  const phone = req.query.phone as string | undefined;

  if (!phone) {
    res.status(400).json({
      success: false,
      message: 'Phone number is required to view an order'
    });
    return;
  }

  const order = await Order.findOne({ orderNumber, phone }).select('-__v');

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
    notes: z.string().trim().max(500).optional(),
    district: z.enum(DISTRICTS).optional(),
    deliveryArea: z.enum(DELIVERY_AREAS).optional()
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

  const { district, deliveryArea, ...contact } = parsed.data;
  const update: Record<string, unknown> = { ...contact };
  // Changing where the parcel goes can change the fee, so it is only allowed
  // before the order is confirmed; the API recomputes the fee and total.
  const changesDelivery = district !== undefined || deliveryArea !== undefined;
  let allowedStatuses: { $nin: OrderStatus[] } | OrderStatus = { $nin: FINAL_STATUSES };

  if (changesDelivery) {
    const current = await Order.findById(req.params.id).select('status district deliveryArea subtotal deliveryFee');
    if (!current) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }
    if (current.status !== 'Pending') {
      res.status(409).json({ success: false, message: 'The delivery area can only be changed while the order is Pending' });
      return;
    }

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
      update.total = current.subtotal + (update.deliveryFee as number);
    }
    allowedStatuses = 'Pending';
  }

  const order = await Order.findOneAndUpdate(
    { _id: req.params.id, status: allowedStatuses },
    { $set: update },
    { returnDocument: 'after', runValidators: true }
  ).select('-__v');

  if (!order) {
    const exists = await Order.exists({ _id: req.params.id });
    res.status(exists ? 409 : 404).json({
      success: false,
      message: !exists
        ? 'Order not found'
        : changesDelivery
          ? 'The delivery area can only be changed while the order is Pending'
          : 'Delivered or cancelled orders can no longer be edited'
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
  if (oldStatus === 'Pending' && status === 'Processing') {
    const taken: { productId: string; quantity: number }[] = [];

    for (const item of order.items) {
      const result = await Product.updateOne(
        { _id: item.productId, stock: { $gte: item.quantity } },
        { $inc: { stock: -item.quantity } }
      );

      if (result.matchedCount === 0) {
        // This item couldn't be taken — give back any stock taken earlier in
        // the loop and release the claim so the order is left completely untouched
        for (const t of taken) {
          await Product.updateOne({ _id: t.productId }, { $inc: { stock: t.quantity } });
        }
        await Order.updateOne({ _id: id, status }, { $set: { status: oldStatus } });

        const product = await Product.findById(item.productId).select('name stock');
        res.status(409).json({
          success: false,
          message: `Insufficient stock for "${product?.name ?? item.name}": only ${product?.stock ?? 0} left, order needs ${item.quantity}`
        });
        return;
      }

      taken.push({ productId: String(item.productId), quantity: item.quantity });
    }
  }

  // Cancelling a confirmed order puts its stock back
  if (oldStatus === 'Processing' && status === 'Cancelled') {
    for (const item of order.items) {
      await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
    }
  }

  res.json({
    success: true,
    data: order,
    message: 'Order status updated successfully'
  });
});

export default router;
