// Data embedded inside every JWT we sign (see src/routes/auth.ts)
export interface AdminPayload {
  id: string;
  email: string;
  role: string;
}

// Tells TypeScript that req.admin exists on every Express Request
// (set by the requireAdmin middleware after verifying the JWT)
declare global {
  namespace Express {
    interface Request {
      admin?: AdminPayload;
    }
  }
}
