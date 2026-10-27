import { useState } from 'react';
import { api, ApiError } from '../api';
import { useMe } from '../hooks';

const MESSAGES: Record<string, string> = {
  sent: 'Verification email sent. Check your inbox.',
  throttled: 'Please wait a minute before requesting another email.',
  not_configured: "This server can't send email yet, so verification isn't available.",
  failed: "We couldn't send the email. Try again later.",
};

/** Shown to accounts whose email is unverified: they can't receive invitations by email until it is. */
export default function VerifyEmailBanner() {
  const { me } = useMe();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me.email || me.emailVerified) return null;

  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ result: string }>('/me/verify-email', 'POST');
      setMsg(MESSAGES[r.result] ?? 'Done.');
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 429 ? MESSAGES.throttled : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack">
      <strong>Verify your email</strong>
      <span className="muted small">
        Confirm {me.email} to receive invitations sent to that address. Invite links work without it.
      </span>
      <button className="btn btn-secondary" disabled={busy} onClick={send}>Send verification email</button>
      {msg && <span className="small">{msg}</span>}
    </div>
  );
}
