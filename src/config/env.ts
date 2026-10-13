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

  for (const name of ['DELIVERY_FEE', 'DELIVERY_FEE_INSIDE_DHAKA', 'DELIVERY_FEE_OUTSIDE_DHAKA']) {
    const fee = env[name];
    if (fee !== undefined && fee !== '' && !(Number.isFinite(Number(fee)) && Number(fee) >= 0)) {
      warnings.push(`${name} is not a valid non-negative number; it will be ignored`);
    }
  }

  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    warnings.push('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are not all set; admin photo upload will be unavailable');
  }

  if (!env.STEADFAST_API_KEY || !env.STEADFAST_SECRET_KEY) {
    warnings.push('STEADFAST_API_KEY and STEADFAST_SECRET_KEY are not both set; booking parcels with Steadfast will be unavailable');
  }

  if (!env.STOREFRONT_API_KEY) {
    warnings.push('STOREFRONT_API_KEY is not set, so the storefront server shares one rate limit with every shopper; set the same random value on the API and the storefront');
  } else if (env.STOREFRONT_API_KEY.length < 32) {
    problems.push('STOREFRONT_API_KEY should be at least 32 characters (generate one the same way as JWT_SECRET)');
  }

  if (!env.EMAIL_API_KEY || !env.NOTIFY_EMAIL_TO) {
    warnings.push('EMAIL_API_KEY and NOTIFY_EMAIL_TO are not both set; new orders will not be emailed to you');
  }

  return { errors, warnings };
}
