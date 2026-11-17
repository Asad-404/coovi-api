import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import Admin from '../models/Admin';
import { AdminPayload } from '../types';
import { Permission, effectivePermissions, isOwnerRole } from '../permissions';
import { AuthenticationError, AuthorizationError } from '../errors';

export { isOwnerRole };

// Verifies the "Authorization: Bearer <token>" header before admin routes, then
// checks the account in the database: a switched-off account, or a token signed
// before the last password change or reset, is refused at once instead of
// working until the token's one-day expiry. Role and permissions are read here
// on every request, so changing someone's access applies on their next click.
export const requireAdmin = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const correlationId = (req as any).correlationId;

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('Authentication required', {
        reason: 'missing_token',
        correlationId
      });
    }

    const token = authHeader.split(' ')[1];

    let decoded: AdminPayload;
    try {
      // Read at call time, not import time: dotenv loads after imports in index.ts
      decoded = jwt.verify(token, process.env.JWT_SECRET || '') as AdminPayload;
    } catch {
      throw new AuthenticationError('Invalid or expired token', {
        reason: 'invalid_token',
        correlationId
      });
    }

    const admin = await Admin.findById(decoded.id).select('email role permissions active tokenVersion').lean();

    // Tokens from before this check have no tv, so they stop working once: sign in again
    if (!admin || !admin.active || decoded.tv !== admin.tokenVersion) {
      throw new AuthenticationError('Invalid or expired token', {
        reason: admin?.active === false ? 'account_inactive' : 'token_revoked',
        correlationId
      });
    }

    req.admin = {
      id: String(admin._id),
      email: admin.email,
      role: admin.role,
      tv: admin.tokenVersion,
      permissions: effectivePermissions(admin.role, admin.permissions)
    };
    next();
  } catch (error) {
    next(error);
  }
};

// Team management: owners only. Use after requireAdmin.
export const requireOwner = (req: Request, _res: Response, next: NextFunction): void => {
  if (!isOwnerRole(req.admin?.role)) {
    next(new AuthorizationError('Only the shop owner can do this', {
      resource: 'admin',
      action: 'owner_only',
      correlationId: (req as any).correlationId
    }));
    return;
  }
  next();
};

// One ticked permission (owners have them all). Use after requireAdmin.
export const requirePermission =
  (permission: Permission) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.admin?.permissions?.includes(permission)) {
      next(new AuthorizationError('You do not have access to this. Ask the shop owner.', {
        resource: 'permission',
        action: permission,
        correlationId: (req as any).correlationId
      }));
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
