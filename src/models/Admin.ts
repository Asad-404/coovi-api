import mongoose, { Schema, Document } from 'mongoose';

// owner: everything. staff: orders and products, but no money, settings, team or
// product delete. 'admin' is the role every account had before roles existed; it
// is turned into 'owner' on startup (src/index.ts) and treated as owner until then.
export const ADMIN_ROLES = ['owner', 'staff'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number] | 'admin';

export interface IAdmin extends Document {
  email: string;
  passwordHash: string;
  name: string;
  role: AdminRole;
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
      enum: [...ADMIN_ROLES, 'admin'],
      default: 'staff'
    },
    // A switched-off account can't sign in, and its existing sign-ins stop working
    active: {
      type: Boolean,
      default: true
    },
    // Copied into every token at sign-in. Raising it (password change or reset,
    // role change, switched off) makes every older token for this account invalid.
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
