import { Link } from 'react-router-dom';
import Icon from '../components/Icon';
import Wave from '../components/Wave';

/** TODO(maintainer): replace with the real contact address before launch. */
export const PRIVACY_CONTACT_EMAIL = 'privacy@example.com';

export default function Privacy() {
  return (
    <>
      <section className="hero">
        <span className="hero-icon"><Icon name="lock" size={36} /></span>
        <h1>Privacy policy</h1>
        <p>What Lojubets stores about you, and why.</p>
      </section>
      <Wave />
      <main className="page">
        <section className="stack">
          <h2>Who is responsible</h2>
          <p>
            Lojubets is a small hobby app for bets between friends, run by its maintainer (the data controller). Questions or requests about
            your data: <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`}>{PRIVACY_CONTACT_EMAIL}</a>.
          </p>
        </section>

        <section className="stack">
          <h2>What we store</h2>
          <ul>
            <li>Your email address and, if you sign up with a password, a hash of it (we never store the password itself).</li>
            <li>Your display name and profile photo, if you set them. Photos are stored in our database.</li>
            <li>If you sign in with Google, Microsoft or Apple: the account identifier and email address that provider shares with us.</li>
            <li>Your friendships, the bets you create or join, and your guesses.</li>
            <li>The email addresses of friends you invite, so we can send the invitation and connect you when they join.</li>
          </ul>
        </section>

        <section className="stack">
          <h2>Why</h2>
          <p>
            Only to run the app: signing you in, showing your friends who you are, running bets and sending the emails the app needs
            (verification, invitations, bet reminders). We don't sell your data, show ads or profile you.
          </p>
        </section>

        <section className="stack">
          <h2>Who handles it for us</h2>
          <ul>
            <li>Vercel hosts the app.</li>
            <li>Turso hosts the database.</li>
            <li>Resend sends our emails.</li>
            <li>Google, Microsoft and Apple, if you choose to sign in with them.</li>
          </ul>
        </section>

        <section className="stack">
          <h2>Cookies</h2>
          <p>
            We use only essential first-party cookies: one keeps you signed in (for 30 days), and short-lived ones carry a sign-in or
            account-merge step through to the end. There are no analytics, no tracking or advertising cookies, and we don't use
            localStorage. That is why there is no cookie banner.
          </p>
        </section>

        <section className="stack">
          <h2>How long we keep it</h2>
          <p>
            For as long as your account exists. Bets are shared with the friends who took part in them, so they stay visible to them.
            Invitation addresses are kept while the invitation is open.
          </p>
        </section>

        <section className="stack">
          <h2>Your rights</h2>
          <p>
            You can ask us for a copy of your data, to correct it, to export it, or to have your account deleted. Much of it you can
            already correct yourself on your <Link to="/profile">profile</Link>. For the rest, including deletion for now, contact us at the
            address above and we'll take care of it.
          </p>
        </section>

        <Link className="btn btn-secondary" to="/">Back</Link>
      </main>
    </>
  );
}
