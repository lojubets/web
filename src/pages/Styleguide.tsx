import { Link } from 'react-router-dom';
import Avatar from '../components/Avatar';
import Icon, { type IconName } from '../components/Icon';
import Rule from '../components/Rule';
import '../design/styleguide.css';

const BRAND = [
  { name: 'Dark Cherry', token: '--cherry-700', hex: '#6A1F3A', ink: '#F5EDE6', use: 'Brand and primary action' },
  { name: 'Champagne', token: '--champagne-500', hex: '#D7B59A', ink: '#1B1218', use: 'Accent' },
  { name: 'Lemon Yellow', token: '--lemon-500', hex: '#F6C600', ink: '#1B1218', use: 'Attention: "you owe"' },
  { name: 'Soft Ivory', token: '--ivory-50', hex: '#F5EDE6', ink: '#1B1218', use: 'Main text, light page' },
  { name: 'Deep Plum', token: '--plum-900', hex: '#1B1218', ink: '#F5EDE6', use: 'Dark canvas' },
  { name: 'Muted Mauve', token: '--mauve-500', hex: '#A47E88', ink: '#1B1218', use: 'Secondary accents' },
];
const SUPPORT = [
  { name: 'Plum 800', token: '--plum-800', hex: '#292027', ink: '#F5EDE6', use: 'Card on dark' },
  { name: 'Plum 700', token: '--plum-700', hex: '#3A2B34', ink: '#F5EDE6', use: 'Interactive surface' },
  { name: 'Plum 600', token: '--plum-600', hex: '#49333D', ink: '#F5EDE6', use: 'Hairline on dark' },
  { name: 'Cherry 600', token: '--cherry-600', hex: '#83304E', ink: '#F5EDE6', use: 'Hover' },
  { name: 'Cherry 800', token: '--cherry-800', hex: '#531730', ink: '#F5EDE6', use: 'Pressed' },
  { name: 'Ivory 100', token: '--ivory-100', hex: '#EADFD5', ink: '#1B1218', use: 'Tinted panel' },
  { name: 'Mauve 700', token: '--mauve-700', hex: '#6B4F58', ink: '#FFFFFF', use: 'Muted text on light' },
  { name: 'Mauve 600', token: '--mauve-600', hex: '#86656F', ink: '#FFFFFF', use: 'Control border on light' },
  { name: 'Mauve 300', token: '--mauve-300', hex: '#C4B4BA', ink: '#1B1218', use: 'Muted text on dark' },
  { name: 'Champagne 800', token: '--champagne-800', hex: '#724628', ink: '#FFFFFF', use: 'Champagne text on light' },
  { name: 'Signal 700', token: '--signal-700', hex: '#B3261E', ink: '#FFFFFF', use: 'Errors only' },
  { name: 'Signal 100', token: '--signal-100', hex: '#FBE7E5', ink: '#B3261E', use: 'Error tint' },
];
const SPACES = [4, 8, 12, 16, 24, 32, 48, 64, 96];
const ICONS: IconName[] = ['glass', 'friends', 'user', 'plus', 'chevron-left', 'clock', 'flame', 'lock', 'mail', 'check', 'pencil', 'alert', 'trash', 'star', 'trophy'];

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
      <h1>LoJuBets style guide</h1>
      <p className="muted">Every token and component, live. Rules are in <code className="sg-code">docs/guidelines/visual/new/brand-guide.html</code>; follow your device's light or dark setting to see both.</p>

      <section>
        <h2>Brand colors</h2>
        <div className="sg-swatches">{BRAND.map((s) => <Swatch key={s.token} s={s} big />)}</div>
        <h2>Supporting colors</h2>
        <div className="sg-swatches">{SUPPORT.map((s) => <Swatch key={s.token} s={s} />)}</div>
      </section>

      <section>
        <h2>Typography</h2>
        <div className="sg-specimen"><span className="eyebrow">Display · Georgia 400 · 40/1.1</span><span style={{ font: '400 var(--text-display)/1.1 var(--font-display)' }}>Closest guess wins</span></div>
        <div className="sg-specimen"><span className="eyebrow">H1 · Georgia 400 · 30/1.15</span><h1>Will Barca win on Saturday?</h1></div>
        <div className="sg-specimen"><span className="eyebrow">H2 · Georgia 400 · 22/1.25</span><h2 style={{ margin: 0 }}>Your move</h2></div>
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
        <small className="slot slot-hint">Like 3:05, 25 days or 3 months and 2 days</small>
        <small className="slot slot-read"><Icon name="check" size={16} /><span>= <b>3 months and 2 days</b> (92 days in total)</span></small>
        <small className="slot slot-warn"><Icon name="alert" size={16} /><span>= <b>3 minutes</b> "m" means minutes. For months, write "months" or "mo".</span></small>
        <small className="slot slot-error"><Icon name="alert" size={16} /><span>Can't read that as a duration.</span></small>
      </section>

      <section>
        <h2>Cards, chips, avatars</h2>
        <div className="card row"><Avatar user={demoUser} size={44} /><div className="bet-main"><div className="bet-q">How many goals does Barca score on Saturday?</div><div className="muted small">vs Sam Stone · In play</div></div></div>
        <a className="card needs-action" href="#sg" onClick={(e) => e.preventDefault()}>
          <div className="bet-main"><div className="bet-q">When will it happen?</div><div className="muted small">vs Sam Stone · Your guess is needed</div><div className="tags"><span className="pill pill-cherry">Your move</span><span className="pill pill-dare"><Icon name="clock" size={14} />18 h</span></div></div>
        </a>
        <div className="tags">
          <span className="pill">Neutral</span><span className="pill pill-cherry">Your move</span><span className="pill pill-positive">Verified</span><span className="pill pill-dare"><Icon name="flame" size={14} />All-in 3 GTs</span>
        </div>
        <p><span className="owed">Sam owes you 3 GTs</span> · <span className="owe">You owe Sam 2 GTs</span> · <span className="muted">You're even</span></p>
        <div className="row"><Avatar user={demoUser} size={48} /><Avatar user={{ ...demoUser, name: 'lkoskela@reaktor.fi' }} size={48} /></div>
      </section>

      <section>
        <h2>Banners</h2>
        <div className="banner banner-win"><Icon name="trophy" size={22} /><span>You won 1 GT! Sam owes you.</span></div>
        <div className="banner banner-owe"><Icon name="glass" size={22} /><span>Sam won. You owe 1 GT.</span></div>
        <div className="banner banner-dare"><Icon name="flame" size={22} /><span>All-in: double or nothing for 3 GTs</span></div>
        <div className="banner banner-danger"><Icon name="alert" size={22} /><span>We couldn't send the email. Try again later.</span></div>
      </section>

      <section>
        <h2>Icons</h2>
        <div className="sg-icons">{ICONS.map((n) => <figure key={n}><Icon name={n} size={28} />{n}</figure>)}</div>
      </section>

      <section>
        <h2>Hero and navigation</h2>
        <div className="sg-preview">
          <div className="hero"><img className="hero-glass" src="/glass-256.png" width="112" height="112" alt="" /><h1>LoJuBets</h1><p>Settle it with a friend. Closest guess wins a Gin & Tonic.</p></div>
          <Rule />
          <div style={{ height: 'var(--space-5)' }} />
        </div>
        <nav className="tabbar sg-tabbar" aria-label="Example">
          <a className="active" href="#sg" onClick={(e) => e.preventDefault()}><span className="tab-icon"><Icon name="glass" size={24} /></span>Bets<b className="badge">2</b></a>
          <a href="#sg" onClick={(e) => e.preventDefault()}><span className="tab-icon"><Icon name="friends" size={24} /></span>Friends</a>
          <a href="#sg" onClick={(e) => e.preventDefault()}><span className="tab-icon"><Icon name="user" size={24} /></span>Profile</a>
        </nav>
      </section>
    </main>
  );
}
