import mongoose, { Schema, Document } from 'mongoose';

// A customer phone the shop has marked as risky (fake orders, refused parcels).
// Orders from it are still accepted; the admin shows them in red so someone
// calls to confirm before shipping (owner decision 2026-10-15). Unblocking
// deletes the record.
export interface IBlockedPhone extends Document {
  phone: string;
  // Why it was blocked, shown next to every order from this phone
  note?: string;
  // Email and id of the admin who blocked it
  by: string;
  byId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const BlockedPhoneSchema = new Schema<IBlockedPhone>(
  {
    phone: { type: String, required: true, unique: true, trim: true },
    note: { type: String, trim: true, maxlength: 300 },
    by: { type: String, required: true },
    byId: { type: String }
  },
  { timestamps: true }
);

export default mongoose.model<IBlockedPhone>('BlockedPhone', BlockedPhoneSchema);
