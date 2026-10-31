import Order from '../models/Order';
import CourierPayment from '../models/CourierPayment';
import { SHORT_ORDER_NUMBER, generateOrderNumber, shortCodeFromLongNumber } from '../services/orderPricing';

export interface OrderNumberChange {
  id: string;
  from: string;
  to: string;
}

export interface OrderNumberPlan {
  totalOrders: number;
  changes: OrderNumberChange[];
  // Orders whose new number could not be taken from the old one, so the old number stops working
  freshCodes: OrderNumberChange[];
  // Steadfast refuses a repeat invoice, which is what makes a booking retry safe,
  // so an order caught mid-booking must keep its number until the booking settles
  unfinishedBookings: string[];
  courierPaymentsToUpdate: number;
}

const paymentLinesWithCurrentNumbers = async (numberById: Map<string, string>) => {
  const payments = await CourierPayment.find().select('lines').lean();
  return payments.flatMap((payment) => {
    let changed = false;
    const lines = payment.lines.map((line) => {
      // An order deleted since the payment was recorded keeps the number on the statement
      const current = numberById.get(String(line.order)) ?? line.orderNumber;
      if (current === line.orderNumber) return line;
      changed = true;
      return { ...line, orderNumber: current };
    });
    return changed ? [{ id: payment._id, lines }] : [];
  });
};

const loadOrders = () =>
  Order.find().select('orderNumber courier').sort({ createdAt: 1, _id: 1 }).lean();

export async function planOrderNumberChanges(): Promise<OrderNumberPlan> {
  const orders = await loadOrders();
  const taken = new Set(orders.map((o) => o.orderNumber).filter((n) => SHORT_ORDER_NUMBER.test(n)));
  const toRenumber = orders.filter((o) => !SHORT_ORDER_NUMBER.test(o.orderNumber));

  // Oldest first, so when two orders share a code the older one keeps it.
  // Fresh codes are drawn afterwards so they can't take a code another order needs.
  const changes: OrderNumberChange[] = [];
  const needFreshCode: typeof toRenumber = [];
  for (const order of toRenumber) {
    const code = shortCodeFromLongNumber(order.orderNumber);
    if (code && !taken.has(code)) {
      taken.add(code);
      changes.push({ id: String(order._id), from: order.orderNumber, to: code });
    } else {
      needFreshCode.push(order);
    }
  }

  const freshCodes: OrderNumberChange[] = [];
  for (const order of needFreshCode) {
    let code = generateOrderNumber();
    while (taken.has(code)) code = generateOrderNumber();
    taken.add(code);
    freshCodes.push({ id: String(order._id), from: order.orderNumber, to: code });
  }
  changes.push(...freshCodes);

  const numberById = new Map(orders.map((o) => [String(o._id), o.orderNumber]));
  for (const change of changes) numberById.set(change.id, change.to);

  return {
    totalOrders: orders.length,
    changes,
    freshCodes,
    unfinishedBookings: orders
      .filter((o) => o.courier?.bookingStartedAt && !o.courier.trackingCode)
      .map((o) => o.orderNumber),
    courierPaymentsToUpdate: (await paymentLinesWithCurrentNumbers(numberById)).length
  };
}

// Safe to run again after a failure: renumbered orders are skipped, and payment
// lines are always rebuilt from the orders they point to.
export async function applyOrderNumberChanges(plan: OrderNumberPlan): Promise<void> {
  if (plan.unfinishedBookings.length > 0) {
    throw new Error(`Orders have an unfinished Steadfast booking: ${plan.unfinishedBookings.join(', ')}`);
  }

  // timestamps off: a new number is not a change the "last updated" date should show
  for (const change of plan.changes) {
    await Order.updateOne({ _id: change.id }, { $set: { orderNumber: change.to } }, { timestamps: false });
  }

  const orders = await loadOrders();
  const numberById = new Map(orders.map((o) => [String(o._id), o.orderNumber]));
  for (const { id, lines } of await paymentLinesWithCurrentNumbers(numberById)) {
    await CourierPayment.updateOne({ _id: id }, { $set: { lines } }, { timestamps: false });
  }
}
