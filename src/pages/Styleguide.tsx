import { Link } from 'react-router-dom';
import Avatar from '../components/Avatar';
import Icon, { type IconName } from '../components/Icon';
import Wave from '../components/Wave';
import '../design/styleguide.css';

const BRAND = [
  { name: 'Pineapple', token: '--yellow-500', hex: '#FDD815', ink: '#082754', use: 'Action and attention' },
  { name: 'Navy', token: '--navy-900', hex: '#082754', ink: '#FFFBEB', use: 'Ink and structure' },
  { name: 'Leaf', token: '--green-500', hex: '#4D9942', ink: '#082754', use: 'Success, "you\'re owed"' },
];
const SUPPORT = [
  { name: 'Cream 50', token: '--cream-50', hex: '#FFFBEB', ink: '#082754', use: 'Page' },
  { name: 'Cream 100', token: '--cream-100', hex: '#FFF3CE', ink: '#082754', use: 'Tinted panel' },
  { name: 'Navy 800', token: '--navy-800', hex: '#0E3366', ink: '#FFFBEB', use: 'Dark surface' },
  { name: 'Navy 600', token: '--navy-600', hex: '#4A5E80', ink: '#FFFFFF', use: 'Muted text' },
  { name: 'Navy 500', token: '--navy-500', hex: '#5F7396', ink: '#FFFFFF', use: 'Control border' },
  { name: 'Navy 200', token: '--navy-200', hex: '#C9D2E1', ink: '#082754', use: 'Hairline' },
  { name: 'Yellow 300', token: '--yellow-300', hex: '#FEE766', ink: '#082754', use: 'Hover' },
  { name: 'Yellow 600', token: '--yellow-600', hex: '#E0BC00', ink: '#082754', use: 'Pressed' },
  { name: 'Leaf 700', token: '--green-700', hex: '#2E6B26', ink: '#FFFFFF', use: 'Green text' },
  { name: 'Leaf 100', token: '--green-100', hex: '#E3F1E0', ink: '#2E6B26', use: 'Green tint' },
  { name: 'Signal 700', token: '--signal-700', hex: '#B3261E', ink: '#FFFFFF', use: 'Errors only' },
  { name: 'Signal 100', token: '--signal-100', hex: '#FBE7E5', ink: '#B3261E', use: 'Error tint' },
];
const SPACES = [4, 8, 12, 16, 24, 32, 48, 64, 96];
const ICONS: IconName[] = ['can', 'friends', 'user', 'plus', 'chevron-left', 'clock', 'flame', 'lock', 'mail', 'check', 'pencil', 'alert', 'trophy'];

function Swatch({ s, big }: { s: (typeof BRAND)[number]; big?: boolean }) {
  return (
    <div className="sg-swatch">
      <div className={`sg-chip ${big ? 'big' : ''}`} style={{ background: `var(${s.token})`, color: s.ink }}>{s.name}</div>
      <div className="sg-meta"><code>{s.token}</code><br />{s.hex} · {s.use}</div>
    </div>
  );
}

export default function Styleguide() {
  const demoUser = { id: 'x', name: 'Sam Stone', hasAvatar: false, avatarVersion: 0 };
  return (
    <main className="page sg">
      <header className="header">
        <Link to="/" className="back"><Icon name="chevron-left" size={22} />App</Link>
        <span className="eyebrow">Design system</span>
      </header>
      <h1>Lojubets style guide</h1>
      <p className="muted">Every token and component, live. Rules are in <code className="sg-code">docs/brand-guide.md</code>; follow your device's light or dark setting to see both.</p>

      <section>
        <h2>Brand colors</h2>
        <div className="sg-swatches">{BRAND.map((s) => <Swatch key={s.token} s={s} big />)}</div>
        <h2>Supporting colors</h2>
        <div className="sg-swatches">{SUPPORT.map((s) => <Swatch key={s.token} s={s} />)}</div>
      </section>

      <section>
        <h2>Typography</h2>
        <div className="sg-specimen"><span className="eyebrow">Display · Fredoka 700 · 36/1.1</span><span style={{ font: '700 var(--text-display)/1.1 var(--font-display)' }}>Closest guess wins</span></div>
        <div className="sg-specimen"><span className="eyebrow">H1 · Fredoka 700 · 28/1.15</span><h1>Will Barca win on Saturday?</h1></div>
        <div className="sg-specimen"><span className="eyebrow">H2 · Fredoka 600 · 20/1.25</span><h2 style={{ margin: 0 }}>Your move</h2></div>
        <div className="sg-specimen"><span className="eyebrow">H3 · Inter 700 · 17/1.3</span><h3>How many goals does Barca score?</h3></div>
        <div className="sg-specimen"><span className="eyebrow">Body · Inter 400 · 16/1.5</span><p>The person in the red can go all-in on a bet in play: double or nothing.</p></div>
        <div className="sg-specimen"><span className="eyebrow">Small · Inter · 14/1.4</span><p className="small muted">Your guess stays hidden until your friend locks theirs in.</p></div>
        <div className="sg-specimen"><span className="eyebrow">Caption · Inter 700 caps · 12</span><span className="eyebrow">Development only</span></div>
      </section>

      <section>
        <h2>Space · 4px grid</h2>
        {SPACES.map((n) => (
          <div className="sg-space" key={n}><i style={{ width: n }} /><span>{n}px</span></div>
        ))}
        <p className="small muted">Related things 8-12 · list items 12-16 · groups 32 · gutters 16 · heroes 48+.</p>
      </section>

      <section>
        <h2>Buttons</h2>
        <button className="btn">Primary: propose bet</button>
        <button className="btn btn-secondary">Secondary</button>
        <button className="btn btn-danger"><Icon name="flame" size={20} />Danger: go all-in</button>
        <button className="btn" disabled>Disabled</button>
        <div className="row row-wrap"><button className="btn btn-small">Accept</button><button className="btn btn-small btn-secondary">Decline</button></div>
        <button className="link">Text link</button>
      </section>

      <section>
        <h2>Fields</h2>
        <label className="field"><span>Question</span><input placeholder="When will Infantino resign?" /></label>
        <label className="field"><span>With a hint</span><input defaultValue="3:05" /><small>Like 3:05 or 3 hours 5 minutes</small></label>
        <label className="check"><input type="checkbox" defaultChecked /> Whole numbers only</label>
        <div className="segmented two" role="radiogroup" aria-label="Example">
          <button type="button" role="radio" aria-checked="true"><strong>Date</strong></button>
          <button type="button" role="radio" aria-checked="false"><strong>Date &amp; time</strong></button>
        </div>
        <p className="error"><Icon name="alert" size={20} />Must be a whole number</p>
      </section>

      <section>
        <h2>Cards, chips, avatars</h2>
        <div className="card row"><Avatar user={demoUser} size={44} /><div className="bet-main"><div className="bet-q">How many goals does Barca score on Saturday?</div><div className="muted small">vs Sam Stone · In play</div></div></div>
        <a className="card needs-action" href="#sg" onClick={(e) => e.preventDefault()}>
          <div className="bet-main"><div className="bet-q">When will it happen?</div><div className="muted small">vs Sam Stone · Your guess is needed</div><div className="tags"><span className="pill pill-yellow">Your move</span><span className="pill pill-navy"><Icon name="clock" size={14} />18 h</span></div></div>
        </a>
        <div className="tags">
          <span className="pill">Neutral</span><span className="pill pill-yellow">Your move</span><span className="pill pill-green">Verified</span><span className="pill pill-navy"><Icon name="flame" size={14} />All-in 3 lonkeros</span>
        </div>
        <p><span className="owed">Sam owes you 3 lonkeros</span> · <span className="owe">You owe Sam 2 lonkeros</span> · <span className="muted">You're even</span></p>
        <div className="row"><Avatar user={demoUser} size={48} /><Avatar user={{ ...demoUser, name: 'lkoskela@reaktor.fi' }} size={48} /></div>
      </section>

      <section>
        <h2>Banners</h2>
        <div className="banner banner-win"><Icon name="trophy" size={22} /><span>You won 1 lonkero! Sam owes you.</span></div>
        <div className="banner banner-owe"><Icon name="can" size={22} /><span>Sam won. You owe 1 lonkero.</span></div>
        <div className="banner banner-dare"><Icon name="flame" size={22} /><span>All-in: double or nothing for 3 lonkeros</span></div>
        <div className="banner banner-danger"><Icon name="alert" size={22} /><span>We couldn't send the email. Try again later.</span></div>
      </section>

      <section>
        <h2>Icons</h2>
        <div className="sg-icons">{ICONS.map((n) => <figure key={n}><Icon name={n} size={28} />{n}</figure>)}</div>
      </section>

      <section>
        <h2>Hero and navigation</h2>
        <div className="sg-preview">
          <div className="hero"><img className="hero-can" src="/can-256.png" width="112" height="112" alt="" /><h1>Lojubets</h1><p>Settle it with a friend. Closest guess wins a lonkero.</p></div>
          <Wave />
          <div style={{ height: 'var(--space-5)' }} />
        </div>
        <nav className="tabbar sg-tabbar" aria-label="Example">
          <a className="active" href="#sg" onClick={(e) => e.preventDefault()}><span className="tab-icon"><Icon name="can" size={24} /></span>Bets<b className="badge">2</b></a>
          <a href="#sg" onClick={(e) => e.preventDefault()}><span className="tab-icon"><Icon name="friends" size={24} /></span>Friends</a>
          <a href="#sg" onClick={(e) => e.preventDefault()}><span className="tab-icon"><Icon name="user" size={24} /></span>Profile</a>
        </nav>
      </section>
    </main>
  );
}
