import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Admin, { IAdmin } from '../models/Admin';
import { requireAdmin, requireOwner } from '../middleware/auth';
import {
  PERMISSIONS,
  ROLES,
  effectivePermissions,
  isCustomized,
  isOwnerRole,
  normalizePermissions,
  presetFor
} from '../permissions';

// Team: the owner adds logins, picks each person's role, adjusts their
// permissions, switches them off and resets their passwords. Owner only.
const router = Router();
router.use(requireAdmin, requireOwner);

// What the Team page shows (never the password hash or token version)
const toMember = (admin: Pick<IAdmin, 'email' | 'name' | 'role' | 'permissions' | 'active' | 'createdAt' | 'updatedAt'> & { _id: unknown }) => ({
  _id: String(admin._id),
  email: admin.email,
  name: admin.name,
  role: admin.role,
  active: admin.active,
  permissions: effectivePermissions(admin.role, admin.permissions),
  customized: isCustomized(admin.role, admin.permissions),
  createdAt: admin.createdAt,
  updatedAt: admin.updatedAt
});

const password = z.string().min(8, 'must be at least 8 characters').max(100);
const permissionList = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length * 2);

const createBodySchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  name: z.string().trim().min(1).max(80),
  role: z.enum(ROLES),
  // Left out: the role's preset
  permissions: permissionList.optional(),
  password
});

const updateBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    // A new role without permissions resets them to that role's preset
    role: z.enum(ROLES).optional(),
    permissions: permissionList.optional(),
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

// Owners have everything, so nothing is stored for them
const storedPermissions = (role: string, permissions?: z.infer<typeof permissionList>): string[] =>
  isOwnerRole(role) ? [] : permissions ? normalizePermissions(permissions) : presetFor(role);

// Owners who can still sign in, other than the given account
const otherActiveOwners = (id: string): Promise<number> =>
  Admin.countDocuments({ _id: { $ne: id }, role: { $in: ['owner', 'admin'] }, active: true });

// GET /api/admins - Everyone with an admin login
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const admins = await Admin.find().sort({ createdAt: 1 }).lean();
  res.json({ success: true, data: admins.map(toMember) });
});

// POST /api/admins - Add a login with a temporary password the owner passes on
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = createBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error, 'Invalid team member data');
    return;
  }

  const { email, name, role, permissions } = parsed.data;
  if (await Admin.exists({ email })) {
    res.status(409).json({ success: false, message: 'An account with this email already exists' });
    return;
  }

  const admin = await Admin.create({
    email,
    name,
    role,
    permissions: storedPermissions(role, permissions),
    passwordHash: await bcrypt.hash(parsed.data.password, 10)
  });

  res.status(201).json({ success: true, data: toMember(admin), message: 'Team member added' });
});

// PATCH /api/admins/:id - Rename, change role or permissions, or switch an account off or on.
// Role and permission changes apply on the person's next request (they are read
// from the database every time); switching off also signs them out at once.
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

  const { name, role, permissions, active } = parsed.data;
  const nextRole = role ?? admin.role;
  const losesOwner = isOwnerRole(admin.role) && admin.active && (!isOwnerRole(nextRole) || active === false);
  if (losesOwner && (await otherActiveOwners(id)) === 0) {
    res.status(409).json({
      success: false,
      message: 'The shop needs at least one active owner. Make someone else an owner first.'
    });
    return;
  }

  if (permissions !== undefined && isOwnerRole(nextRole)) {
    res.status(400).json({ success: false, message: 'Owners always have every permission' });
    return;
  }

  const switchedOff = active === false && admin.active;
  if (name !== undefined) admin.name = name;
  if (role !== undefined || permissions !== undefined) {
    admin.role = nextRole;
    admin.permissions = storedPermissions(nextRole, permissions);
  }
  if (active !== undefined) admin.active = active;
  if (switchedOff) admin.tokenVersion += 1;
  await admin.save();

  res.json({ success: true, data: toMember(admin), message: 'Team member updated' });
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
