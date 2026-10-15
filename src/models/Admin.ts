import mongoose, { Schema, Document } from 'mongoose';
import { PERMISSIONS, ROLES, Role } from '../permissions';

// Roles are in src/permissions.ts. 'admin' is the role every account had before
// roles existed; it is turned into 'owner' on startup (src/index.ts) and treated
// as owner until then.
export type AdminRole = Role | 'admin';

export interface IAdmin extends Document {
  email: string;
  passwordHash: string;
  name: string;
  role: AdminRole;
  // This person's own ticks (ignored for owners, who can do everything)
  permissions: string[];
  active: boolean;
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const AdminSchema = new Schema<IAdmin>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true
    },
    passwordHash: {
      type: String,
      required: true
    },
    name: {
      type: String,
      default: 'Coovi Admin'
    },
    role: {
      type: String,
      enum: [...ROLES, 'admin'],
      default: 'viewer'
    },
    permissions: {
      type: [{ type: String, enum: PERMISSIONS }],
      default: []
    },
    // A switched-off account can't sign in, and its existing sign-ins stop working
    active: {
      type: Boolean,
      default: true
    },
    // Copied into every token at sign-in. Raising it (password change or reset,
    // switched off) makes every older token for this account invalid.
    tokenVersion: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

export default mongoose.model<IAdmin>('Admin', AdminSchema);
