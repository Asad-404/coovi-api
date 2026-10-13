import Order, { type IOrder, type IOrderItem } from '../models/Order';
import Product from '../models/Product';

export interface RequestedItem {
  productId: string;
  quantity: number;
}

export type BuildItemsResult =
  | { ok: true; items: IOrderItem[]; subtotal: number }
  | { ok: false; message: string };

// Loads the REAL products from the DB — the source of truth for price, name and
// image (CC-1: never trust the browser) — and checks each line can be sold.
// Shared by the public checkout and the admin's manual order entry so both
// price an order exactly the same way.
export async function buildOrderItems(items: RequestedItem[]): Promise<BuildItemsResult> {
  const productIds = items.map((item) => item.productId);
  const products = await Product.find({ _id: { $in: productIds } }).select('name price stock inStock images size allowPreorder preorderDays');
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  for (const item of items) {
    const product = productMap.get(item.productId);

    if (!product) {
      return { ok: false, message: `Item is no longer available (product ${item.productId})` };
    }

    // The admin's "Available for sale" switch (inStock) takes a product off sale even while units remain
    if (!product.inStock) {
      return { ok: false, message: `"${product.name}" is currently unavailable` };
    }

    // Not enough stock: a pre-order product takes the whole line as a pre-order instead
    if (product.stock < item.quantity && !product.allowPreorder) {
      return { ok: false, message: `Only ${product.stock} left of "${product.name}" — you asked for ${item.quantity}` };
    }
  }

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
  return { ok: true, items: orderItems, subtotal };
}

// Generate order number
const generateOrderNumber = (): string => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `ORD-${year}${month}${day}-${random}`;
};

type NewOrderFields = Omit<Partial<IOrder>, 'orderNumber'>;

// The unique orderNumber index can reject a random collision (1-in-1000/day) —
// generating a fresh number and retrying is friendlier than erroring.
// Returns null when three attempts all collided.
export async function createOrderWithNumber(fields: NewOrderFields): Promise<IOrder | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await Order.create({ ...fields, orderNumber: generateOrderNumber() });
    } catch (error: any) {
      if (error.code !== 11000) throw error;
    }
  }
  return null;
}
