import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth';
import { readLimiter } from '../middleware/rateLimiters';
import { getSettings, publicSettings, updateSettings } from '../services/settings';

const router = Router();

// Partial and STRICT: the admin saves one section at a time, and any unknown
// field is rejected rather than silently ignored
const settingsBodySchema = z.strictObject({
  whatsappNumber: z
    .string()
    .trim()
    .regex(/^8801[3-9]\d{8}$/, 'must be a Bangladeshi mobile number in international format, like 8801712345678'),
  supportPhone: z
    .string()
    .trim()
    .regex(/^(01[3-9]\d{8})?$/, 'must be a Bangladeshi mobile number like 01712345678, or empty'),
  announcementText: z.string().trim().max(120),
  announcementActive: z.boolean(),
  lowStockThreshold: z.number().int().min(0).max(1000)
}).partial().refine((s) => Object.keys(s).length > 0, { message: 'send at least one setting to change' });

// GET /api/settings - Public shop settings for the storefront (contact number, announcement)
router.get('/', readLimiter, async (_req: Request, res: Response): Promise<void> => {
  const settings = await getSettings();
  res.json({ success: true, data: publicSettings(settings) });
});

// GET /api/settings/admin - Every setting, for the admin settings page
router.get('/admin', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  res.json({ success: true, data: await getSettings() });
});

// PATCH /api/settings - Change one or more settings (Admin only)
router.patch('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const parsed = settingsBodySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: 'Invalid settings',
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    });
    return;
  }

  // An announcement switched on needs some text to show
  const current = await getSettings();
  const merged = { ...current, ...parsed.data };
  if (merged.announcementActive && !merged.announcementText) {
    res.status(400).json({
      success: false,
      message: 'Invalid settings',
      errors: ['announcementText: add the announcement text before turning it on']
    });
    return;
  }

  const settings = await updateSettings(parsed.data);
  res.json({ success: true, data: settings, message: 'Settings saved' });
});

export default router;
