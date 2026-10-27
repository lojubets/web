import app from './app.js';
import { mailConfigured } from './email.js';
import { env } from './env.js';

const port = Number(process.env.PORT ?? 3001);
const database = env.databaseUrl.startsWith('file:') ? env.databaseUrl : new URL(env.databaseUrl).host;

app.listen(port, (err?: Error) => {
  // Express 5 hands listen errors (e.g. EADDRINUSE) to this callback instead of throwing.
  if (err) {
    console.error(`\nCannot listen on port ${port}: ${err.message}\nIs another dev server still running? Stop it and try again.\n`);
    process.exit(1);
  }
  console.log(`API on http://localhost:${port}`);
  console.log(`  database:  ${database}`);
  console.log(`  email:     ${mailConfigured() ? 'Resend' : 'not configured (verification/invite links are printed here)'}`);
  console.log(`  dev login: ${env.devLogin ? 'on' : 'off'}`);
});
