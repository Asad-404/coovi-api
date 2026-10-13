// Steadfast Courier merchant API: books a parcel and reads its delivery status.
// Docs: Steadfast merchant portal → API. Every call sends the shop's Api-Key and
// Secret-Key headers, so this file only ever runs on the server.

const DEFAULT_BASE_URL = 'https://portal.packzy.com/api/v1';

// Steadfast answers in a few seconds; a stuck call must not hang the admin's request
const TIMEOUT_MS = 15_000;

// Public tracking page a customer or admin can open without logging in
export const steadfastTrackingUrl = (trackingCode: string): string =>
  `https://steadfast.com.bd/t/${encodeURIComponent(trackingCode)}`;

// Missing keys: the route answers 503 "not configured" instead of calling Steadfast
export class SteadfastNotConfiguredError extends Error {}

// Steadfast refused the request, timed out or could not be reached
export class SteadfastError extends Error {}

interface SteadfastConfig {
  baseUrl: string;
  apiKey: string;
  secretKey: string;
}

// Read at call time, not import time: dotenv loads after imports in index.ts
function getConfig(): SteadfastConfig {
  const apiKey = process.env.STEADFAST_API_KEY;
  const secretKey = process.env.STEADFAST_SECRET_KEY;

  if (!apiKey || !secretKey) {
    throw new SteadfastNotConfiguredError('Steadfast courier is not configured on the server');
  }

  return {
    baseUrl: (process.env.STEADFAST_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey,
    secretKey
  };
}

// Steadfast puts validation problems in `errors: { field: ["message"] }`
function describeError(body: any, fallback: string): string {
  if (body?.errors && typeof body.errors === 'object') {
    const messages = Object.values(body.errors).flat().filter((m) => typeof m === 'string');
    if (messages.length) return `Steadfast: ${messages.join(', ')}`;
  }
  return typeof body?.message === 'string' && body.message ? `Steadfast: ${body.message}` : fallback;
}

async function call(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<any> {
  const { baseUrl, apiKey, secretKey } = getConfig();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        'Api-Key': apiKey,
        'Secret-Key': secretKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error: any) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new SteadfastError(timedOut ? 'Steadfast did not answer in time, try again' : 'Could not reach Steadfast, try again');
  }

  const body: any = await response.json().catch(() => null);

  // Steadfast can report a failure in the body even with HTTP 200, so check both
  if (!response.ok || !body || (typeof body.status === 'number' && body.status !== 200)) {
    throw new SteadfastError(describeError(body, `Steadfast refused the request (HTTP ${response.status})`));
  }

  return body;
}

export interface SteadfastParcel {
  invoice: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  codAmount: number;
  note?: string;
}

export interface SteadfastBooking {
  consignmentId: number;
  trackingCode: string;
  status: string;
}

// POST /create_order. The invoice (our order number) must be unique at Steadfast,
// so the same order can never be booked twice there.
export async function createSteadfastParcel(parcel: SteadfastParcel): Promise<SteadfastBooking> {
  const body = await call('/create_order', {
    method: 'POST',
    body: {
      invoice: parcel.invoice,
      recipient_name: parcel.recipientName,
      recipient_phone: parcel.recipientPhone,
      recipient_address: parcel.recipientAddress,
      cod_amount: parcel.codAmount,
      ...(parcel.note && { note: parcel.note })
    }
  });

  const consignment = body.consignment;
  if (!consignment?.consignment_id || !consignment?.tracking_code) {
    throw new SteadfastError(describeError(body, 'Steadfast did not return a tracking code'));
  }

  return {
    consignmentId: Number(consignment.consignment_id),
    trackingCode: String(consignment.tracking_code),
    status: String(consignment.status ?? 'in_review')
  };
}

// GET /status_by_cid/:id → e.g. "in_review", "pending", "hold", "delivered", "cancelled"
export async function getSteadfastStatus(consignmentId: number): Promise<string> {
  const body = await call(`/status_by_cid/${encodeURIComponent(String(consignmentId))}`, { method: 'GET' });

  if (typeof body.delivery_status !== 'string') {
    throw new SteadfastError('Steadfast did not return a delivery status');
  }

  return body.delivery_status;
}
