export interface EnvCheck {
  errors: string[];
  warnings: string[];
}

const WEAK_ADMIN_PASSWORDS = new Set(['admin123', 'password', '12345678', 'changeme']);

// Pure function so it can be tested. In production any error stops the server from starting;
// in development the same problems are only warnings.
export function checkEnv(env: NodeJS.ProcessEnv = process.env): EnvCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProduction = env.NODE_ENV === 'production';
  const problems = isProduction ? errors : warnings;

  if (!env.MONGODB_URI) errors.push('MONGODB_URI is not set');

  if (!env.JWT_SECRET) {
    errors.push('JWT_SECRET is not set');
  } else if (env.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET should be at least 32 characters (generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")');
  }

  if (!env.CORS_ORIGINS) {
    problems.push('CORS_ORIGINS is not set, so only the local dev frontends are allowed; set it to the real storefront and admin URLs');
  } else if (isProduction && /localhost|127\.0\.0\.1/.test(env.CORS_ORIGINS)) {
    problems.push('CORS_ORIGINS still contains a localhost address');
  }

  if (env.ADMIN_PASSWORD && WEAK_ADMIN_PASSWORDS.has(env.ADMIN_PASSWORD.toLowerCase())) {
    problems.push('ADMIN_PASSWORD is a well-known weak password; choose a strong one');
  }

  const fee = env.DELIVERY_FEE;
  if (fee !== undefined && fee !== '' && !(Number.isFinite(Number(fee)) && Number(fee) >= 0)) {
    warnings.push('DELIVERY_FEE is not a valid non-negative number; the default of 60 will be used');
  }

  return { errors, warnings };
}
