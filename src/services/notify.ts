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
  'orderNumber' | 'customerName' | 'phone' | 'address' | 'items' | 'subtotal' | 'deliveryFee' | 'total' | 'notes'
>;

export function buildNewOrderEmail(order: AlertOrder, adminUrl?: string): { subject: string; html: string; text: string } {
  const hasPreorder = order.items.some((item) => item.preorder);
  const lines = order.items.map((item) => {
    const wait = item.preorder ? ` (pre-order, about ${item.preorderDays ?? 15} days)` : '';
    return `${item.name}${wait} x ${item.quantity} = ৳${item.price * item.quantity}`;
  });
  const link = adminUrl ? `${adminUrl.replace(/\/+$/, '')}/orders` : undefined;

  const subject = `New order ${order.orderNumber}: ৳${order.total}${hasPreorder ? ' (includes pre-order)' : ''}`;

  const text = [
    `New order ${order.orderNumber}`,
    '',
    `Customer: ${order.customerName}`,
    `Phone: ${order.phone}`,
    `Address: ${order.address}`,
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
<strong>Address:</strong> ${escapeHtml(order.address)}${order.notes ? `<br><strong>Notes:</strong> ${escapeHtml(order.notes)}` : ''}</p>
<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
<p>Subtotal: ৳${order.subtotal}<br>Delivery: ৳${order.deliveryFee}<br><strong>Total (cash on delivery): ৳${order.total}</strong></p>
${link ? `<p><a href="${escapeHtml(link)}">Open the admin</a></p>` : ''}`;

  return { subject, html, text };
}

// Sends the alert, or does nothing when email is not configured. Never throws:
// a failed alert must not fail or slow down the customer's order.
export async function notifyNewOrder(order: AlertOrder, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const apiKey = env.EMAIL_API_KEY;
  const to = env.NOTIFY_EMAIL_TO;
  if (!apiKey || !to) return;

  try {
    const { subject, html, text } = buildNewOrderEmail(order, env.ADMIN_URL);
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.NOTIFY_EMAIL_FROM || DEFAULT_FROM,
        to: to.split(',').map((address) => address.trim()).filter(Boolean),
        subject,
        html,
        text
      }),
      signal: AbortSignal.timeout(10_000)
    });

    if (!res.ok) {
      console.error(`New-order email for ${order.orderNumber} failed: ${res.status} ${await res.text()}`);
    }
  } catch (error) {
    console.error(`New-order email for ${order.orderNumber} failed:`, error);
  }
}
