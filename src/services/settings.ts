import Settings, { ISettings, SETTINGS_DEFAULTS } from '../models/Settings';

export type ShopSettings = typeof SETTINGS_DEFAULTS & { updatedAt?: Date };

// The storefront reads settings on many page loads; caching for a minute keeps
// that from being a database read every time. An admin save clears it at once.
const CACHE_MS = 60 * 1000;
let cached: { value: ShopSettings; expiresAt: number } | null = null;

function toPlain(doc: ISettings): ShopSettings {
  return {
    whatsappNumber: doc.whatsappNumber,
    supportPhone: doc.supportPhone,
    announcementText: doc.announcementText,
    announcementActive: doc.announcementActive,
    lowStockThreshold: doc.lowStockThreshold,
    updatedAt: doc.updatedAt
  };
}

// Returns the shop settings, creating the document with the defaults on first read.
// The upsert is atomic, so two first requests at once still make only one document.
export async function getSettings(): Promise<ShopSettings> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const doc = await Settings.findOneAndUpdate(
    { key: 'shop' },
    { $setOnInsert: SETTINGS_DEFAULTS },
    { upsert: true, new: true }
  );

  const value = toPlain(doc);
  cached = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

// Saves only the fields given and returns the full, fresh settings
export async function updateSettings(changes: Partial<typeof SETTINGS_DEFAULTS>): Promise<ShopSettings> {
  // Make sure the document exists (with defaults) before applying a partial change
  await getSettings();
  const doc = await Settings.findOneAndUpdate({ key: 'shop' }, { $set: changes }, { new: true });
  cached = null;
  return toPlain(doc!);
}

// Public view: never includes admin-only fields such as lowStockThreshold
export function publicSettings(s: ShopSettings) {
  return {
    whatsappNumber: s.whatsappNumber,
    supportPhone: s.supportPhone,
    announcementText: s.announcementText,
    announcementActive: s.announcementActive
  };
}

// Tests swap the database between files; this keeps a cached value from leaking across
export function clearSettingsCache(): void {
  cached = null;
}
