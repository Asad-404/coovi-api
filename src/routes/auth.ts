import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Admin from '../models/Admin';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// POST /api/auth/login - Exchange email + password for a JWT token
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
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
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to log in',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

// GET /api/auth/me - Return the current admin (from the Bearer token)
router.get('/me', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
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
  } catch (error) {
    console.error('Error fetching admin:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch admin',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

export default router;
