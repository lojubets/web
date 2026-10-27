const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

function defaultAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'http://localhost:5173';
}

if (isProd && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}

export const env = {
  isProd,
  databaseUrl: process.env.DATABASE_URL || 'file:local.db',
  databaseAuthToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-secret-do-not-use-in-production',
  appUrl: defaultAppUrl(),
  devLogin: !isProd && process.env.DEV_LOGIN !== 'off',
  resendApiKey: process.env.RESEND_API_KEY,
  resendFrom: process.env.RESEND_FROM || 'Lojubets <onboarding@resend.dev>',
};
