import { env } from './env.js';

export const mailConfigured = () => !!env.resendApiKey;

/** Sends via Resend if configured. Returns whether an email was actually sent. */
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  if (!env.resendApiKey) {
    if (!env.isProd) console.log(`\n[mail not configured] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.resendFrom, to, subject, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const sendInviteEmail = (to: string, inviterName: string, link: string) =>
  sendMail(
    to,
    `${inviterName} wants to bet you a lonkero`,
    `${inviterName} invited you to Lojubets, where friends settle disputes one lonkero at a time.\n\nAccept the invitation: ${link}`,
  );
