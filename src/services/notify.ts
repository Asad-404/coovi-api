import type { IOrder } from '../models/Order';

// New-order alerts by email through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
// An HTTP API rather than SMTP because many hosts, Render's free plan among them, block outgoing SMTP ports.
// Switched on only when EMAIL_API_KEY and NOTIFY_EMAIL_TO are set, like the Cloudinary upload.
const RESEND_URL = 'https://api.resend.com/emails';

// Resend's shared test sender may only email the address that owns the Resend account,
// which is exactly the owner's alert inbox. Set NOTIFY_EMAIL_FROM once the shop's own domain is verified.
const DEFAULT_FROM = 'Coovi Orders <onboarding@resend.dev>';

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type AlertOrder = Pick<
  IOrder,
  'orderNumber' | 'customerName' | 'phone' | 'address' | 'district' | 'items' | 'subtotal' | 'deliveryFee' | 'total' | 'notes'
>;

export function buildNewOrderEmail(order: AlertOrder, adminUrl?: string): { subject: string; html: string; text: string } {
  const hasPreorder = order.items.some((item) => item.preorder);
  const lines = order.items.map((item) => {
    const wait = item.preorder ? ` (pre-order, about ${item.preorderDays ?? 15} days)` : '';
    return `${item.name}${wait} x ${item.quantity} = ৳${item.price * item.quantity}`;
  });
  const address = order.district ? `${order.address}, ${order.district}` : order.address;
  const link = adminUrl ? `${adminUrl.replace(/\/+$/, '')}/orders` : undefined;

  const subject = `New order ${order.orderNumber}: ৳${order.total}${hasPreorder ? ' (includes pre-order)' : ''}`;

  const text = [
    `New order ${order.orderNumber}`,
    '',
    `Customer: ${order.customerName}`,
    `Phone: ${order.phone}`,
    `Address: ${address}`,
    ...(order.notes ? [`Notes: ${order.notes}`] : []),
    '',
    ...lines,
    `Subtotal: ৳${order.subtotal}`,
    `Delivery: ৳${order.deliveryFee}`,
    `Total (cash on delivery): ৳${order.total}`,
    ...(link ? ['', `Open the admin: ${link}`] : [])
  ].join('\n');

  const html = `<h2>New order ${escapeHtml(order.orderNumber)}</h2>
<p><strong>Customer:</strong> ${escapeHtml(order.customerName)}<br>
<strong>Phone:</strong> <a href="tel:${escapeHtml(order.phone)}">${escapeHtml(order.phone)}</a><br>
<strong>Address:</strong> ${escapeHtml(address)}${order.notes ? `<br><strong>Notes:</strong> ${escapeHtml(order.notes)}` : ''}</p>
<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
<p>Subtotal: ৳${order.subtotal}<br>Delivery: ৳${order.deliveryFee}<br><strong>Total (cash on delivery): ৳${order.total}</strong></p>
${link ? `<p><a href="${escapeHtml(link)}">Open the admin</a></p>` : ''}`;

  return { subject, html, text };
}

const isConfigured = (env: NodeJS.ProcessEnv): boolean => Boolean(env.EMAIL_API_KEY && env.NOTIFY_EMAIL_TO);

// Posts one email to Resend. Never throws: a failed alert must not fail or slow down the customer's order.
async function sendEmail(email: { subject: string; html: string; text: string }, label: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.NOTIFY_EMAIL_FROM || DEFAULT_FROM,
        to: env.NOTIFY_EMAIL_TO!.split(',').map((address) => address.trim()).filter(Boolean),
        ...email
      }),
      signal: AbortSignal.timeout(10_000)
    });

    if (res.status === 429) {
      // Resend answers 429 when the plan's daily or per-second limit is used up
      console.error(`New-order email for ${label} was refused: the Resend sending limit is used up, so alerts stop until it resets. ${await res.text()}`);
    } else if (!res.ok) {
      console.error(`New-order email for ${label} failed: ${res.status} ${await res.text()}`);
    }
  } catch (error) {
    console.error(`New-order email for ${label} failed:`, error);
  }
}

// Sends the alert for one order, or does nothing when email is not configured. Never throws.
export async function notifyNewOrder(order: AlertOrder, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isConfigured(env)) return;
  await sendEmail(buildNewOrderEmail(order, env.ADMIN_URL), order.orderNumber, env);
}

// A summary listing several orders that arrived close together
const SUMMARY_MAX_ORDERS = 20;

export function buildOrdersSummaryEmail(orders: AlertOrder[], adminUrl?: string): { subject: string; html: string; text: string } {
  const total = orders.reduce((sum, order) => sum + order.total, 0);
  const shown = orders.slice(0, SUMMARY_MAX_ORDERS).map((order) => buildNewOrderEmail(order));
  const more = orders.length - shown.length;
  const moreLine = more > 0 ? `...and ${more} more. See them all in the admin.` : '';
  const link = adminUrl ? `${adminUrl.replace(/\/+$/, '')}/orders` : undefined;

  const subject = `${orders.length} new orders: ৳${total}`;

  const text = [
    `${orders.length} new orders arrived close together (৳${total} in total).`,
    ...(link ? [`Open the admin: ${link}`] : []),
    ...shown.map((email) => `\n----------\n${email.text}`),
    ...(moreLine ? ['', moreLine] : [])
  ].join('\n');

  const html = `<p>${orders.length} new orders arrived close together (৳${total} in total).${link ? ` <a href="${escapeHtml(link)}">Open the admin</a>` : ''}</p>
${shown.map((email) => `<hr>${email.html}`).join('\n')}${moreLine ? `\n<p>${escapeHtml(moreLine)}</p>` : ''}`;

  return { subject, html, text };
}

// At most one alert email per ALERT_WINDOW_MS. The first order after a quiet spell is emailed at
// once; orders arriving within the window are held and sent together as one summary when it ends.
// So a burst of fake orders can't use up the email plan's daily limit and hide the real orders.
// Held orders live in memory: a restart in those few minutes loses their email (the orders are
// saved and still show in the admin).
export const ALERT_WINDOW_MS = 5 * 60 * 1000;

let lastSentAt = -Infinity;
let held: AlertOrder[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function sendHeld(env: NodeJS.ProcessEnv): Promise<void> {
  const orders = held;
  held = [];
  timer = null;
  lastSentAt = Date.now();
  if (orders.length === 1) return notifyNewOrder(orders[0], env);
  return sendEmail(buildOrdersSummaryEmail(orders, env.ADMIN_URL), `${orders.length} orders`, env);
}

// Called for every website order. Never throws.
export async function alertNewOrder(order: AlertOrder, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isConfigured(env)) return;

  const now = Date.now();
  if (!timer && now - lastSentAt >= ALERT_WINDOW_MS) {
    lastSentAt = now;
    await notifyNewOrder(order, env);
    return;
  }

  held.push(order);
  timer ??= setTimeout(() => void sendHeld(env), lastSentAt + ALERT_WINDOW_MS - now);
}

// Tests reset the window between cases
export function resetAlertWindow(): void {
  if (timer) clearTimeout(timer);
  lastSentAt = -Infinity;
  held = [];
  timer = null;
}
