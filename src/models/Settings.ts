import mongoose, { Schema, Document } from 'mongoose';

// Shop-wide settings the owner edits from the admin panel. There is exactly ONE
// document, found by `key: 'shop'`; src/services/settings.ts creates it on first read.
export interface ISettings extends Document {
  key: string;
  // International format, digits only: 8801XXXXXXXXX (used for wa.me links)
  whatsappNumber: string;
  // Local format 01XXXXXXXXX, or empty when not shown
  supportPhone: string;
  // The blue strip under the storefront header
  announcementText: string;
  announcementActive: boolean;
  // Admin only: products with fewer than this many in stock count as low stock
  lowStockThreshold: number;
  createdAt: Date;
  updatedAt: Date;
}

// The defaults match what the live storefront showed before settings existed,
// so the first deploy changes nothing a customer can see
export const SETTINGS_DEFAULTS = {
  whatsappNumber: '8801700000000',
  supportPhone: '',
  announcementText: 'Shop the festive collection',
  announcementActive: true,
  lowStockThreshold: 6
};

const SettingsSchema = new Schema<ISettings>(
  {
    key: { type: String, required: true, unique: true, default: 'shop' },
    whatsappNumber: { type: String, default: SETTINGS_DEFAULTS.whatsappNumber },
    supportPhone: { type: String, default: SETTINGS_DEFAULTS.supportPhone },
    announcementText: { type: String, default: SETTINGS_DEFAULTS.announcementText },
    announcementActive: { type: Boolean, default: SETTINGS_DEFAULTS.announcementActive },
    lowStockThreshold: { type: Number, default: SETTINGS_DEFAULTS.lowStockThreshold, min: 0 }
  },
  { timestamps: true }
);

export default mongoose.model<ISettings>('Settings', SettingsSchema);
