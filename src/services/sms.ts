import type { IOrder } from '../models/Order';

// Order confirmation SMS to the customer. Off unless SMS_PROVIDER and SMS_API_KEY are set,
// like the Cloudinary upload and the email alert.
//
// Each Bangladeshi SMS company has its own HTTP API, so the order code only talks to this
// small interface. Adding another company means one more case in getSmsProvider().
export interface SmsProvider {
  name: string;
  // Resolves when the provider accepted the message, throws with the provider's reason otherwise
  send(to: string, message: string): Promise<void>;
}

// Alpha SMS (sms.net.bd), docs: https://sms.net.bd/api
// POST rather than GET so the API key never ends up in a URL or a request log.
const ALPHA_SMS_URL = 'https://api.sms.net.bd/sendsms';

export function alphaSmsProvider(apiKey: string, senderId?: string): SmsProvider {
  return {
    name: 'alpha',
    async send(to, message) {
      const form = new URLSearchParams({ api_key: apiKey, msg: message, to });
      if (senderId) form.set('sender_id', senderId);

      const res = await fetch(ALPHA_SMS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(10_000)
      });
      const text = await res.text();

      // Alpha answers {"error":0,"msg":"Request successfully submitted",...}; any other error code is a refusal
      let body: { error?: unknown; msg?: unknown } = {};
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: reported below with the raw text
      }
      if (!res.ok || body.error === undefined || Number(body.error) !== 0) {
        throw new Error(`Alpha SMS refused the message: ${res.status} ${typeof body.msg === 'string' ? body.msg : text}`);
      }
    }
  };
}

export function getSmsProvider(env: NodeJS.ProcessEnv = process.env): SmsProvider | null {
  const provider = env.SMS_PROVIDER?.trim().toLowerCase();
  const apiKey = env.SMS_API_KEY;
  if (!provider || !apiKey) return null;

  switch (provider) {
    case 'alpha':
      return alphaSmsProvider(apiKey, env.SMS_SENDER_ID || undefined);
    default:
      console.error(`SMS_PROVIDER "${env.SMS_PROVIDER}" is not supported; customer SMS is off`);
      return null;
  }
}

// The checkout only accepts 01XXXXXXXXX; SMS companies want the country code in front
export const toInternationalBdPhone = (phone: string): string => `88${phone}`;

type SmsOrder = Pick<IOrder, 'orderNumber' | 'phone' | 'total'>;

// Plain English letters and "Tk" instead of "৳": one Bengali character switches the whole SMS
// to Unicode, which cuts a single message from 160 to 70 characters and doubles the cost.
export function buildOrderConfirmationSms(order: SmsOrder, storefrontUrl?: string): string {
  const track = storefrontUrl ? ` Track: ${storefrontUrl.replace(/\/+$/, '')}/track-order` : '';
  return `Coovi: order ${order.orderNumber} received. Total Tk ${order.total}, cash on delivery. We will call you to confirm.${track}`;
}

// Sends the confirmation, or does nothing when SMS is not configured. Never throws:
// a failed SMS must not fail or slow down the customer's order.
export async function sendOrderConfirmationSms(order: SmsOrder, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const provider = getSmsProvider(env);
  if (!provider) return;

  try {
    await provider.send(toInternationalBdPhone(order.phone), buildOrderConfirmationSms(order, env.STOREFRONT_URL));
  } catch (error) {
    // The phone number stays out of the log: Render's logs are not a place for customer details
    console.error(`Order SMS for ${order.orderNumber} failed:`, error instanceof Error ? error.message : error);
  }
}
