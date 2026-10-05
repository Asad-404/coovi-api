import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Admin from '../models/Admin';
import { requireAdmin } from '../middleware/auth';
import { loginLimiter } from '../middleware/rateLimiters';

const router = Router();

// POST /api/auth/login - Exchange email + password for a JWT token
// (no try/catch — errors fall through to the global error handler)
router.post('/login', loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({
      success: false,
      message: 'Email and password are required'
    });
    return;
  }

  const admin = await Admin.findOne({ email: String(email).toLowerCase() });

  // Same message for wrong email AND wrong password (don't reveal which one)
  if (!admin) {
    res.status(401).json({
      success: false,
      message: 'Invalid email or password'
    });
    return;
  }

  // bcrypt.compare hashes the attempt and checks it against the stored hash
  const isMatch = await bcrypt.compare(password, admin.passwordHash);

  if (!isMatch) {
    res.status(401).json({
      success: false,
      message: 'Invalid email or password'
    });
    return;
  }

  // Sign a token that expires in 1 day; only this server's JWT_SECRET can create it
  const token = jwt.sign(
    { id: admin._id, email: admin.email, role: admin.role },
    process.env.JWT_SECRET || '',
    { expiresIn: '1d' }
  );

  res.json({
    success: true,
    data: {
      token,
      admin: {
        id: admin._id,
        email: admin.email,
        name: admin.name,
        role: admin.role
      }
    },
    message: 'Login successful'
  });
});

// GET /api/auth/me - Return the current admin (from the Bearer token)
router.get('/me', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const admin = await Admin.findById(req.admin?.id).select('-passwordHash');

  if (!admin) {
    res.status(404).json({
      success: false,
      message: 'Admin not found'
    });
    return;
  }

  res.json({
    success: true,
    data: admin
  });
});

// PATCH /api/auth/password - Change the signed-in admin's password.
// Needs the CURRENT password too, so a stolen token alone cannot lock the owner out.
const passwordBodySchema = z.strictObject({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'must be at least 8 characters').max(100)
});

router.patch('/password', requireAdmin, loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = passwordBodySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: 'Invalid password data',
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    });
    return;
  }

  const { currentPassword, newPassword } = parsed.data;
  const admin = await Admin.findById(req.admin?.id);

  if (!admin) {
    res.status(404).json({ success: false, message: 'Admin not found' });
    return;
  }

  const isMatch = await bcrypt.compare(currentPassword, admin.passwordHash);

  if (!isMatch) {
    res.status(401).json({ success: false, message: 'Current password is incorrect' });
    return;
  }

  if (currentPassword === newPassword) {
    res.status(400).json({ success: false, message: 'New password must be different from the current one' });
    return;
  }

  admin.passwordHash = await bcrypt.hash(newPassword, 10);
  await admin.save();

  res.json({ success: true, message: 'Password changed successfully' });
});

export default router;
