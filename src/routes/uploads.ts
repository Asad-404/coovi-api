import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// Every product photo lands in this one Cloudinary folder
const UPLOAD_FOLDER = 'coovi/products';

// Cloudinary's signing rule: the upload parameters sorted A-Z and joined like a query
// string, then the API secret glued on the end, then SHA-1 of the whole text.
export function signUpload(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  return createHash('sha1').update(toSign + apiSecret).digest('hex');
}

// POST /api/uploads/signature - Give the admin panel a short-lived signature so the browser
// can send a photo straight to Cloudinary. The API secret itself never leaves this server.
router.post('/signature', requireAdmin, (_req: Request, res: Response): void => {
  // Read at call time, not import time: dotenv loads after imports in index.ts
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    res.status(503).json({
      success: false,
      message: 'Image upload is not configured on the server'
    });
    return;
  }

  // Cloudinary rejects a signature older than 1 hour, so a leaked one soon stops working
  const timestamp = Math.round(Date.now() / 1000);
  const signature = signUpload({ folder: UPLOAD_FOLDER, timestamp }, apiSecret);

  res.json({
    success: true,
    data: { cloudName, apiKey, timestamp, folder: UPLOAD_FOLDER, signature }
  });
});

export default router;
