import { env } from './env.js';

/** Sends via Resend if configured. Returns whether an email was actually sent. */
export async function sendInviteEmail(to: string, inviterName: string, link: string): Promise<boolean> {
  if (!env.resendApiKey) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.resendFrom,
        to,
        subject: `${inviterName} wants to bet you a beer 🍺`,
        text: `${inviterName} invited you to Lojubets, where friends settle disputes one beer at a time.\n\nAccept the invitation: ${link}`,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
