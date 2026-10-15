// What a team member can do in the admin. Owners can do everything (and are the
// only ones who manage the team); everyone else has their own list, which starts
// from their role's preset and can be adjusted per person on the Team page.
export const PERMISSIONS = [
  'orders.view', // see orders and customer details
  'orders.edit', // change status, edit details, add notes, add manual orders
  'orders.export', // download orders as CSV
  'products.view', // see the product list and stock in the admin
  'products.edit', // add and edit products, upload photos
  'products.delete', // delete products
  'money.view', // revenue and profit on the dashboard
  'payments.view', // see courier payouts
  'payments.edit', // record or delete courier payouts
  'settings.view', // see the Settings page
  'settings.edit' // change shop settings
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['owner', 'manager', 'staff', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

// Starting permissions for each role other than owner
export const ROLE_PRESETS: Record<Exclude<Role, 'owner'>, readonly Permission[]> = {
  manager: [
    'orders.view',
    'orders.edit',
    'orders.export',
    'products.view',
    'products.edit',
    'products.delete',
    'money.view',
    'payments.view',
    'payments.edit'
  ],
  staff: ['orders.view', 'orders.edit', 'products.view', 'products.edit'],
  viewer: ['orders.view', 'products.view']
};

// Each permission that only makes sense with another: you can't edit what you can't see
const NEEDS: Partial<Record<Permission, Permission>> = {
  'orders.edit': 'orders.view',
  'orders.export': 'orders.view',
  'products.edit': 'products.view',
  'products.delete': 'products.view',
  'payments.edit': 'payments.view',
  'settings.edit': 'settings.view'
};

// The role every account had before roles existed counts as owner
export const isOwnerRole = (role: string | undefined): boolean => role === 'owner' || role === 'admin';

// Adds what each permission needs, drops duplicates and keeps the canonical order
export const normalizePermissions = (permissions: readonly Permission[]): Permission[] => {
  const set = new Set<Permission>(permissions);
  for (const permission of permissions) {
    const needed = NEEDS[permission];
    if (needed) set.add(needed);
  }
  return PERMISSIONS.filter((permission) => set.has(permission));
};

export const presetFor = (role: string): Permission[] =>
  isOwnerRole(role) ? [...PERMISSIONS] : normalizePermissions(ROLE_PRESETS[role as Exclude<Role, 'owner'>] ?? []);

// What this account can actually do
export const effectivePermissions = (role: string, permissions: readonly string[] = []): Permission[] =>
  isOwnerRole(role)
    ? [...PERMISSIONS]
    : normalizePermissions(permissions.filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p)));

// True when someone's ticks differ from their role's preset ("Viewer (custom)")
export const isCustomized = (role: string, permissions: readonly string[] = []): boolean => {
  if (isOwnerRole(role)) return false;
  const mine = effectivePermissions(role, permissions);
  const preset = presetFor(role);
  return mine.length !== preset.length || mine.some((p, i) => p !== preset[i]);
};
