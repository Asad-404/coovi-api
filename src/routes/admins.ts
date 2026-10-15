import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Admin, { ADMIN_ROLES } from '../models/Admin';
import { requireAdmin, requireOwner, isOwnerRole } from '../middleware/auth';

// Team: the owner adds staff logins, switches them off and resets their
// passwords. Every route is owner only.
const router = Router();
router.use(requireAdmin, requireOwner);

// Fields safe to show in the Team page (never the password hash or token version)
const PUBLIC_FIELDS = 'email name role active createdAt updatedAt';

const password = z.string().min(8, 'must be at least 8 characters').max(100);

const createBodySchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  name: z.string().trim().min(1).max(80),
  role: z.enum(ADMIN_ROLES),
  password
});

const updateBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    role: z.enum(ADMIN_ROLES).optional(),
    active: z.boolean().optional()
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');

const resetBodySchema = z.strictObject({ password });

const badRequest = (res: Response, error: z.ZodError, message: string): void => {
  res.status(400).json({
    success: false,
    message,
    errors: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
  });
};

const notFound = (res: Response): void => {
  res.status(404).json({ success: false, message: 'Team member not found' });
};

// Owners who can still sign in, other than the given account
const otherActiveOwners = (id: string): Promise<number> =>
  Admin.countDocuments({ _id: { $ne: id }, role: { $in: ['owner', 'admin'] }, active: true });

// GET /api/admins - Everyone with an admin login
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const admins = await Admin.find().select(PUBLIC_FIELDS).sort({ createdAt: 1 }).lean();
  res.json({ success: true, data: admins });
});

// POST /api/admins - Add a login with a temporary password the owner passes on
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = createBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error, 'Invalid team member data');
    return;
  }

  const { email, name, role } = parsed.data;
  if (await Admin.exists({ email })) {
    res.status(409).json({ success: false, message: 'An account with this email already exists' });
    return;
  }

  const admin = await Admin.create({
    email,
    name,
    role,
    passwordHash: await bcrypt.hash(parsed.data.password, 10)
  });
  const created = await Admin.findById(admin._id).select(PUBLIC_FIELDS).lean();

  res.status(201).json({ success: true, data: created, message: 'Team member added' });
});

// PATCH /api/admins/:id - Rename, change role, or switch an account off or on
router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!mongoose.isValidObjectId(id)) {
    notFound(res);
    return;
  }

  const parsed = updateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error, 'Invalid team member data');
    return;
  }

  const admin = await Admin.findById(id);
  if (!admin) {
    notFound(res);
    return;
  }

  const { name, role, active } = parsed.data;
  const losesOwner = isOwnerRole(admin.role) && admin.active && (role === 'staff' || active === false);
  if (losesOwner && (await otherActiveOwners(id)) === 0) {
    res.status(409).json({
      success: false,
      message: 'The shop needs at least one active owner. Make someone else an owner first.'
    });
    return;
  }

  // A new role or a switch-off takes effect at once: older tokens stop working
  const roleChanged = role !== undefined && role !== admin.role;
  const switchedOff = active === false && admin.active;
  if (name !== undefined) admin.name = name;
  if (role !== undefined) admin.role = role;
  if (active !== undefined) admin.active = active;
  if (roleChanged || switchedOff) admin.tokenVersion += 1;
  await admin.save();

  const updated = await Admin.findById(id).select(PUBLIC_FIELDS).lean();
  res.json({ success: true, data: updated, message: 'Team member updated' });
});

// POST /api/admins/:id/reset-password - Give someone a new temporary password.
// Their existing sign-ins stop working. Owners change their own password in
// PATCH /api/auth/password, which also asks for the current one.
router.post('/:id/reset-password', async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!mongoose.isValidObjectId(id)) {
    notFound(res);
    return;
  }

  const parsed = resetBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error, 'Invalid password');
    return;
  }

  if (id === req.admin!.id) {
    res.status(400).json({ success: false, message: 'Use Change password for your own account' });
    return;
  }

  const admin = await Admin.findById(id);
  if (!admin) {
    notFound(res);
    return;
  }

  admin.passwordHash = await bcrypt.hash(parsed.data.password, 10);
  admin.tokenVersion += 1;
  await admin.save();

  res.json({ success: true, message: 'Password reset. Their other sign-ins have been signed out.' });
});

export default router;
