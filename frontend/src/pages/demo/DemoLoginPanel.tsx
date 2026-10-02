import { useEffect, useState } from 'react';
import { label } from '../../lib/labels';

export interface DemoLogin {
  email: string;
  password: string;
  role: string;
  title: string;
  hint: string;
}

/**
 * "Try the demo" on the login page (Change 14, G3). The logins come from the backend at
 * runtime (GET /api/demo/config) and only when DEMO_MODE is on — nothing is compiled into
 * the bundle. Demo users are ordinary users with ordinary scopes.
 */
export function DemoLoginPanel({ onUse }: { onUse: (login: DemoLogin) => void }) {
  const [logins, setLogins] = useState<DemoLogin[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/demo/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { demo_mode?: boolean; logins?: DemoLogin[] } | null) => {
        if (!cancelled && body?.demo_mode && Array.isArray(body.logins)) setLogins(body.logins);
      })
      .catch(() => undefined); // no demo panel when the config can't be read
    return () => {
      cancelled = true;
    };
  }, []);

  if (logins.length === 0) return null;
  return (
    <section className="demo-panel" aria-labelledby="demo-title">
      <h2 id="demo-title">Try the demo</h2>
      <p className="muted small">
        Shared demo accounts with synthetic data. Start as the Brand Admin and follow the demo guide; open the other
        roles in new tabs.
      </p>
      <ul className="demo-logins">
        {logins.map((login) => (
          <li key={login.email}>
            <div>
              <strong>{login.title}</strong> <span className="badge">{label(login.role)}</span>
              <div className="muted small">{login.hint}</div>
            </div>
            <button type="button" className="secondary" onClick={() => onUse(login)} aria-label={`Use ${login.title}`}>
              Use
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
