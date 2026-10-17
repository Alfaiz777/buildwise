import { Check } from 'lucide-react';
import type { DemoLogin } from '../../lib/demoConfig';

export type { DemoLogin } from '../../lib/demoConfig';

/**
 * "Try the demo" on the login page (Change 14, G3; UI-1: filtered to the chosen role; UI-L: a
 * grid of tiles, so every store fits without scrolling). The logins come from GET
 * /api/demo/config via useDemoConfig — never from the bundle. Demo users are ordinary users
 * with ordinary scopes. Choosing a tile fills the form; the password is never shown.
 */
export function DemoLoginPanel({
  logins,
  roleLabel,
  picked = null,
  onUse,
}: {
  logins: DemoLogin[];
  /** The tab's role in words ("Retail Admin"), shown once for the whole panel. */
  roleLabel: string;
  /** The email of the tile last chosen. */
  picked?: string | null;
  onUse: (login: DemoLogin) => void;
}) {
  if (logins.length === 0) return null;
  return (
    <section className="demo-panel login-demo" aria-labelledby="demo-title">
      <div className="login-demo__head">
        <h2 id="demo-title">Try the demo</h2>
        <span className="ui-pill ui-pill--primary">{roleLabel}</span>
      </div>
      <p className="muted small">Shared demo accounts with synthetic data. Pick one to fill the form.</p>
      <ul className={`login-demo__grid${logins.length === 1 ? ' login-demo__grid--one' : ''}`}>
        {logins.map((login, i) => {
          const on = picked === login.email;
          return (
            <li key={login.email} style={{ animationDelay: `${i * 60}ms` }}>
              <button
                type="button"
                className={`login-demo__tile${on ? ' is-picked' : ''}`}
                onClick={() => onUse(login)}
                aria-label={`Use ${login.title}`}
                aria-pressed={on}
                title={login.hint}
              >
                <span className="login-demo__mark" aria-hidden="true">
                  {on ? <Check size={14} /> : initials(login.title)}
                </span>
                <span className="login-demo__text">
                  <strong>{login.title}</strong>
                  <span className="login-demo__hint">{login.hint}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Wellness Mart, Satellite" → "WM"; "Brand Admin — AquaSkin" → "AQ" (the part after the dash). */
function initials(title: string): string {
  const name = (title.split(/\s[—–-]\s/).at(-1) ?? title).split(',')[0]!.trim();
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
}
