export interface SeedGuardInput {
  nodeEnv: string | undefined;
  dbName: string;
  existingProducts: number;
  argv: string[];
}

export interface SeedGuardResult {
  allowed: boolean;
  reason?: string;
}

// Pure function so it can be tested. The seed deletes every product, so it must never run
// against production and must only wipe a catalogue that holds products when the person running
// it has typed that database's name: `pnpm seed --confirm=<database name>`.
export function checkSeedAllowed({ nodeEnv, dbName, existingProducts, argv }: SeedGuardInput): SeedGuardResult {
  if (nodeEnv === 'production') {
    return { allowed: false, reason: 'NODE_ENV is production; the seed never runs against a production database' };
  }

  if (existingProducts === 0) return { allowed: true };

  const confirmArg = argv.find((arg) => arg.startsWith('--confirm='));
  const confirmed = confirmArg?.slice('--confirm='.length);
  if (confirmed !== dbName) {
    return {
      allowed: false,
      reason:
        `database "${dbName}" already holds ${existingProducts} product(s) and the seed would delete all of them. ` +
        `If you really mean to replace them, run: pnpm seed --confirm=${dbName}`,
    };
  }

  return { allowed: true };
}
