import Product from '../models/Product';
import Order from '../models/Order';
import { UPLOAD_FOLDER, signUpload } from '../routes/uploads';

// When a product is deleted, its photos are deleted from Cloudinary too, so the free
// storage doesn't fill up with photos nothing shows any more.
// https://cloudinary.com/documentation/image_upload_api_reference#destroy

const TIMEOUT_MS = 10_000;

// A photo this shop uploaded looks like
// https://res.cloudinary.com/<cloud>/image/upload/v1712345678/coovi/products/abc123.jpg
// Its public id is the part after the version, without the file extension. Anything else
// (another cloud, another folder, a placeholder picture) is not ours to delete.
export function photoPublicId(url: string, cloudName: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'res.cloudinary.com') return null;

  const prefix = `/${cloudName}/image/upload/`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  const parts = decodeURIComponent(parsed.pathname.slice(prefix.length)).split('/');
  const start = parts.indexOf(UPLOAD_FOLDER.split('/')[0]);
  if (start === -1) return null;

  const publicId = parts.slice(start).join('/').replace(/\.[a-z0-9]+$/i, '');
  return publicId.startsWith(`${UPLOAD_FOLDER}/`) && !publicId.includes('..') ? publicId : null;
}

export interface PhotoCleanup {
  deleted: number;
  kept: number;
  failed: number;
}

// Deletes the photos of a product that is already gone from the database. A photo still
// used by another product, or shown on an order line, is kept so old orders keep their
// picture. Never throws: the product is deleted either way, and a photo left behind only
// costs storage.
export async function deleteProductPhotos(images: string[]): Promise<PhotoCleanup> {
  const result: PhotoCleanup = { deleted: 0, kept: 0, failed: 0 };
  // Read at call time, not import time: dotenv loads after imports in index.ts
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return result;

  for (const url of new Set(images)) {
    const publicId = photoPublicId(url, cloudName);
    if (!publicId) continue;

    try {
      const [otherProduct, order] = await Promise.all([
        Product.exists({ images: url }),
        Order.exists({ 'items.image': url })
      ]);
      if (otherProduct || order) {
        result.kept += 1;
        continue;
      }

      const timestamp = Math.round(Date.now() / 1000);
      const body = new URLSearchParams({
        public_id: publicId,
        timestamp: String(timestamp),
        api_key: apiKey,
        signature: signUpload({ public_id: publicId, timestamp }, apiSecret)
      });
      const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/destroy`, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const json = (await res.json().catch(() => ({}))) as { result?: string };
      // "not found" means it is already gone, which is what we wanted
      if (res.ok && (json.result === 'ok' || json.result === 'not found')) {
        result.deleted += 1;
      } else {
        result.failed += 1;
        console.warn(`Could not delete product photo ${publicId} from Cloudinary (status ${res.status})`);
      }
    } catch (error) {
      result.failed += 1;
      console.warn(`Could not delete product photo ${publicId} from Cloudinary:`, error instanceof Error ? error.message : error);
    }
  }
  return result;
}
