import { Link } from 'react-router-dom';
import type { AppConfig } from '../../shared/types';
import Icon from '../components/Icon';
import Wave from '../components/Wave';
import { useFetch } from '../hooks';

export default function Privacy() {
  const { data: config } = useFetch<AppConfig>('/config');
  const contact = config?.privacyContactEmail;

  return (
    <>
      <section className="hero">
        <span className="hero-icon"><Icon name="lock" size={36} /></span>
        <h1>Privacy policy</h1>
        <p>What LoJuBets stores about you, and why.</p>
      </section>
      <Wave />
      <main className="page">
        <section className="stack">
          <h2>Who is responsible</h2>
          <p>
            LoJuBets is a small hobby app for bets between friends, run by its maintainer (the data controller).{' '}
            {contact ? (
              <>Questions or requests about your data: <a href={`mailto:${contact}`}>{contact}</a>.</>
            ) : (
              <>For questions or requests about your data, ask the person who invited you to LoJuBets to pass them on to the maintainer.</>
            )}
          </p>
        </section>

        <section className="stack">
          <h2>What we store</h2>
          <ul>
            <li>Your email address and, if you sign up with a password, a hash of it (we never store the password itself).</li>
            <li>Your display name and profile photo, if you set them. Photos are stored in our database.</li>
            <li>If you sign in with Google, Microsoft or Apple: the account identifier and email address that provider shares with us. We keep no access tokens.</li>
            <li>Your friendships, the bets you create or join, and your guesses.</li>
            <li>The email addresses of friends you invite, so we can send the invitation and connect you when they join.</li>
          </ul>
        </section>

        <section className="stack">
          <h2>Why</h2>
          <p>
            Only to run the app: signing you in, showing your friends who you are, running bets and sending the emails the app needs
            (verification, invitations, bet reminders, and a confirmation when an account is deleted). We don't sell your data, show ads or
            profile you.
          </p>
        </section>

        <section className="stack">
          <h2>Who handles it for us</h2>
          <ul>
            <li>Vercel hosts the app.</li>
            <li>Turso hosts the database.</li>
            <li>Resend sends our emails and keeps its own delivery logs.</li>
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
            For as long as your account exists. When you delete it, your profile, email addresses, photo, sign-in details, friendships and
            invitations are erased at once, and nothing is kept in backups: we have none.
          </p>
          <p>
            Bets are a record between two people, so we don't erase them from the other person's history. Cancelled bets are deleted. Settled
            bets stay with your friend, with you shown as "Deleted user" and your guess removed. The question text stays as it was
            written, so don't put anything in a bet that you wouldn't want your friend to keep. Your friend can remove such bets from their
            own history whenever they like.
          </p>
        </section>

        <section className="stack">
          <h2>Your rights</h2>
          <ul>
            <li><strong>Access and export:</strong> download a copy of your data as a file from the account deletion section of your <Link to="/profile">profile</Link>, without having to delete anything.</li>
            <li><strong>Correction:</strong> change your name, photo and email addresses on your profile.</li>
            <li>
              <strong>Erasure:</strong> delete your account from your profile. If you have bets that are still open, we ask the other person
              to cancel them, and your account is deleted as soon as none are left. If they don't answer within 30 days, the bets are
              cancelled and the deletion goes ahead. If they refuse, the bet stays open until it is settled, because it's their bet too.
            </li>
          </ul>
          <p>
            Stuck, or can't sign in?{' '}
            {contact ? <>Write to <a href={`mailto:${contact}`}>{contact}</a>.</> : <>Ask the person who invited you to contact the maintainer.</>} You
            can also complain to your national data protection authority.
          </p>
        </section>

        <Link className="btn btn-secondary" to="/">Back</Link>
      </main>
    </>
  );
}
