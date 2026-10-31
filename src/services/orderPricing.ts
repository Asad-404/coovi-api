import { randomInt } from 'node:crypto';
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
export async function buildOrderItems(requested: RequestedItem[]): Promise<BuildItemsResult> {
  // The same product on two lines becomes one line, so the stock check below sees the
  // whole quantity (two lines of 1 must not both pass when only 1 is left)
  const quantities = new Map<string, number>();
  for (const { productId, quantity } of requested) {
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
  }
  const items = [...quantities].map(([productId, quantity]) => ({ productId, quantity }));

  const productIds = items.map((item) => item.productId);
  const products = await Product.find({ _id: { $in: productIds } }).select('name price stock inStock images size allowPreorder preorderDays +costPrice');
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
      ...(preorder && { preorderDays: product.preorderDays }),
      // Copied so the profit of this order stays right if the cost changes later
      ...(product.costPrice != null && { costPrice: product.costPrice })
    };
  });

  const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return { ok: true, items: orderItems, subtotal };
}

// Order number + phone are a guest's only credentials for viewing an order, so
// the number must be unguessable: 6 characters from a 30-letter alphabet (no
// look-alikes 0/O, 1/I/L, and no U) is ~729 million, drawn with a cryptographic RNG.
const ORDER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const ORDER_CODE_LENGTH = 6;

export const generateOrderNumber = (): string => {
  let code = '';
  for (let i = 0; i < ORDER_CODE_LENGTH; i++) {
    code += ORDER_CODE_ALPHABET[randomInt(ORDER_CODE_ALPHABET.length)];
  }
  return code;
};

type NewOrderFields = Omit<Partial<IOrder>, 'orderNumber'>;

// The unique orderNumber index can (very rarely) reject a random collision —
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
