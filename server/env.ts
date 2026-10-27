const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

function defaultAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'http://localhost:5173';
}

if (isProd && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}

const databaseUrl = process.env.DATABASE_URL || 'file:local.db';
const localDatabase = databaseUrl.startsWith('file:') || databaseUrl === ':memory:';

// Vercel's filesystem is read-only/ephemeral: a file database would quietly lose data.
if (isProd && localDatabase) throw new Error('DATABASE_URL must be a libsql:// Turso URL in production');
if (!localDatabase && !process.env.DATABASE_AUTH_TOKEN) throw new Error('DATABASE_AUTH_TOKEN is required with a remote DATABASE_URL');

/** A production deployment whose public URL is still a localhost address sends sign-in redirects to the user's own machine. */
export function publicUrlProblem(appUrl: string, production: boolean): string | null {
  if (!production || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(appUrl)) return null;
  return (
    `APP_URL is set to ${appUrl}, but this is a production deployment, so sign-in would redirect to localhost. ` +
    'Set APP_URL to the public URL (for example https://your-app.vercel.app) in the Vercel environment variables, then redeploy.'
  );
}

export const env = {
  isProd,
  databaseUrl,
  databaseAuthToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-secret-do-not-use-in-production',
  appUrl: defaultAppUrl(),
  // The dev login can sign in as any email, so against a remote database it must be asked for explicitly.
  devLogin: !isProd && (localDatabase ? process.env.DEV_LOGIN !== 'off' : process.env.DEV_LOGIN === 'on'),
  resendApiKey: process.env.RESEND_API_KEY,
  resendFrom: process.env.RESEND_FROM || 'LoJuBets <onboarding@resend.dev>',
};
