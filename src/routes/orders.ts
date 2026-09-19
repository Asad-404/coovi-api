import { Router, Request, Response } from 'express';
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

// POST /api/orders - Create new order
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { customerName, phone, address, items, subtotal, deliveryFee, total, notes } = req.body;

    // Validate required fields
    if (!customerName || !phone || !address || !items || items.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
      return;
    }

    // Generate unique order number
    const orderNumber = generateOrderNumber();

    // Create order
    const order = new Order({
      orderNumber,
      customerName,
      phone,
      address,
      items,
      subtotal,
      deliveryFee,
      total,
      notes,
      paymentMethod: 'Cash on Delivery',
      status: 'Pending'
    });

    await order.save();

    res.status(201).json({
      success: true,
      data: order,
      message: 'Order placed successfully'
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create order',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

// GET /api/orders - Get all orders (Admin only - will add auth later)
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
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
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orders',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

// GET /api/orders/:orderNumber - Get single order by order number
router.get('/:orderNumber', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderNumber } = req.params;

    const order = await Order.findOne({ orderNumber }).select('-__v');

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
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

// PATCH /api/orders/:id/status - Update order status (Admin only)
router.patch('/:id/status', async (req: Request, res: Response): Promise<void> => {
  try {
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
    order.status = status;

    // Decrease stock when order is confirmed (status changes to Processing)
    if (oldStatus === 'Pending' && status === 'Processing') {
      for (const item of order.items) {
        await Product.findByIdAndUpdate(
          item.productId,
          { $inc: { stock: -item.quantity } }
        );
      }
    }

    // Restore stock if order is cancelled after being processed
    if (oldStatus === 'Processing' && status === 'Cancelled') {
      for (const item of order.items) {
        await Product.findByIdAndUpdate(
          item.productId,
          { $inc: { stock: item.quantity } }
        );
      }
    }

    await order.save();

    res.json({
      success: true,
      data: order,
      message: 'Order status updated successfully'
    });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update order status',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

export default router;
