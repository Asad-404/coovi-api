import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import Admin from '../models/Admin';
import { AdminPayload } from '../types';
import { Permission, effectivePermissions, isOwnerRole } from '../permissions';

export { isOwnerRole };

const unauthorized = (res: Response): void => {
  res.status(401).json({
    success: false,
    message: 'Invalid or expired token'
  });
};

// Verifies the "Authorization: Bearer <token>" header before admin routes, then
// checks the account in the database: a switched-off account, or a token signed
// before the last password change or reset, is refused at once instead of
// working until the token's one-day expiry. Role and permissions are read here
// on every request, so changing someone's access applies on their next click.
export const requireAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      message: 'Authentication required'
    });
    return;
  }

  const token = authHeader.split(' ')[1];

  let decoded: AdminPayload;
  try {
    // Read at call time, not import time: dotenv loads after imports in index.ts
    decoded = jwt.verify(token, process.env.JWT_SECRET || '') as AdminPayload;
  } catch {
    unauthorized(res);
    return;
  }

  const admin = await Admin.findById(decoded.id).select('email role permissions active tokenVersion').lean();

  // Tokens from before this check have no tv, so they stop working once: sign in again
  if (!admin || !admin.active || decoded.tv !== admin.tokenVersion) {
    unauthorized(res);
    return;
  }

  req.admin = {
    id: String(admin._id),
    email: admin.email,
    role: admin.role,
    tv: admin.tokenVersion,
    permissions: effectivePermissions(admin.role, admin.permissions)
  };
  next();
};

const forbidden = (res: Response, message: string): void => {
  res.status(403).json({ success: false, message });
};

// Team management: owners only. Use after requireAdmin.
export const requireOwner = (req: Request, res: Response, next: NextFunction): void => {
  if (!isOwnerRole(req.admin?.role)) {
    forbidden(res, 'Only the shop owner can do this');
    return;
  }
  next();
};

// One ticked permission (owners have them all). Use after requireAdmin.
export const requirePermission =
  (permission: Permission) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (!req.admin?.permissions?.includes(permission)) {
      forbidden(res, 'You do not have access to this. Ask the shop owner.');
      return;
    }
    next();
  };

// Who did it: stamped on order notes and history entries. Only call it on
// routes behind requireAdmin, where req.admin is always set.
export const actor = (req: Request): { by: string; byId: string } => ({
  by: req.admin!.email,
  byId: req.admin!.id
});
