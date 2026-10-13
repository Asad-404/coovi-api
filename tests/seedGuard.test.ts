import { describe, expect, it } from 'vitest';
import { checkSeedAllowed } from '../src/seedGuard';

const base = { nodeEnv: 'development', dbName: 'coovi', existingProducts: 26, argv: [] as string[] };

describe('checkSeedAllowed', () => {
  it('refuses in production even with the confirmation', () => {
    const result = checkSeedAllowed({ ...base, nodeEnv: 'production', argv: ['--confirm=coovi'] });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/production/);
  });

  it('allows an empty database without confirmation', () => {
    expect(checkSeedAllowed({ ...base, existingProducts: 0 }).allowed).toBe(true);
  });

  it('refuses a database with products when no confirmation is given', () => {
    const result = checkSeedAllowed(base);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('pnpm seed --confirm=coovi');
  });

  it('refuses when the confirmation names a different database', () => {
    expect(checkSeedAllowed({ ...base, argv: ['--confirm=coovi-test'] }).allowed).toBe(false);
    expect(checkSeedAllowed({ ...base, argv: ['--confirm='] }).allowed).toBe(false);
  });

  it('allows a database with products when its name is confirmed', () => {
    expect(checkSeedAllowed({ ...base, argv: ['--confirm=coovi'] }).allowed).toBe(true);
  });
});
