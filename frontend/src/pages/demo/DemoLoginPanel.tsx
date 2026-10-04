import { label } from '../../lib/labels';
import type { DemoLogin } from '../../lib/demoConfig';

export type { DemoLogin } from '../../lib/demoConfig';

/**
 * "Try the demo" on the login page (Change 14, G3; UI-1: filtered to the chosen role).
 * The logins come from GET /api/demo/config via useDemoConfig — never from the bundle.
 * Demo users are ordinary users with ordinary scopes.
 */
export function DemoLoginPanel({ logins, onUse }: { logins: DemoLogin[]; onUse: (login: DemoLogin) => void }) {
  if (logins.length === 0) return null;
  return (
    <section className="demo-panel" aria-labelledby="demo-title">
      <h2 id="demo-title">Try the demo</h2>
      <p className="muted small">Shared demo account with synthetic data. Use fills the form for you.</p>
      <ul className="demo-logins">
        {logins.map((login) => (
          <li key={login.email}>
            <div>
              <strong>{login.title}</strong> <span className="ui-pill ui-pill--primary">{label(login.role)}</span>
              <div className="muted small">{login.hint}</div>
            </div>
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--sm"
              onClick={() => onUse(login)}
              aria-label={`Use ${login.title}`}
            >
              Use
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
