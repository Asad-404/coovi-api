import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth';
import { orderLimiter, orderLookupLimiter } from '../middleware/rateLimiters';
import Order from '../models/Order';
import Product from '../models/Product';

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
  const products = await Product.find({ _id: { $in: productIds } }).select('name price stock images size');
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

    if (product.stock < item.quantity) {
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

// GET /api/orders - Get all orders (Admin only - JWT required)
router.get('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string || '';

  const skip = (page - 1) * limit;

  // Build query
  const query: any = {};
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

// PATCH /api/orders/:id/status - Update order status (Admin only - JWT required)
router.patch('/:id/status', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];

  if (!validStatuses.includes(status)) {
    res.status(400).json({
      success: false,
      message: 'Invalid status'
    });
    return;
  }

  const order = await Order.findById(id);

  if (!order) {
    res.status(404).json({
      success: false,
      message: 'Order not found'
    });
    return;
  }

  const oldStatus = order.status;

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
        // the loop so the order is left completely untouched
        for (const t of taken) {
          await Product.updateOne({ _id: t.productId }, { $inc: { stock: t.quantity } });
        }

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

  order.status = status;
  await order.save();

  res.json({
    success: true,
    data: order,
    message: 'Order status updated successfully'
  });
});

export default router;
