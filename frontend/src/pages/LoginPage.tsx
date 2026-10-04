import { ArrowLeft, Building2, Store, Tags, type LucideIcon } from 'lucide-react';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { Scope } from '../api/apiContext';
import { useAuth } from '../auth/authContext';
import { Wordmark } from '../components/shell/Wordmark';
import { Button } from '../components/ui';
import { useDemoConfig } from '../lib/demoConfig';
import { DemoLoginPanel } from './demo/DemoLoginPanel';

function friendlyAuthError(err: unknown): string {
  const code = (err as { code?: string }).code ?? '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Incorrect email or password.';
  }
  if (code === 'auth/too-many-requests') return 'Too many attempts. Try again later.';
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection.';
  return 'Sign-in failed. Try again.';
}

export type LoginAs = 'brand' | 'store' | 'platform';

interface RoleCopy {
  tab: string;
  heading: string;
  line: string;
  noAccount?: string;
  icon: LucideIcon;
  scope: Scope;
  role: string;
  findHere: [string, string][];
}

const ROLES: Record<LoginAs, RoleCopy> = {
  brand: {
    tab: 'Brand',
    heading: 'Brand login',
    line: 'Sign in to see what Qwikspot did for your brand.',
    noAccount: 'No account yet? The Qwikspot team sets up your brand.',
    icon: Tags,
    scope: 'BRAND',
    role: 'BRAND_ADMIN',
    findHere: [
      ['Results', 'Holds, pickups and online orders that came through Qwikspot.'],
      ['Conversations', "Every chat in your brand's name, and why the AI did what it did."],
      ['Your store network', 'Retailers, stores, their stock and their Store Admins.'],
    ],
  },
  store: {
    tab: 'Store',
    heading: 'Store login',
    line: "Sign in to manage your store's holds.",
    noAccount: 'No account yet? The brand you work with creates your store account.',
    icon: Store,
    scope: 'RETAIL',
    role: 'RETAIL_ADMIN',
    findHere: [
      ["Today's holds", 'Confirm, mark ready and hand over with the customer’s pickup code.'],
      ['Your stock', 'As your brand last imported it, with what is held for customers.'],
      ['Privacy built in', 'Customers are masked; you never see their contact details.'],
    ],
  },
  platform: {
    tab: 'Qwikspot team',
    heading: 'Qwikspot team',
    line: 'Sign in to onboard brands and watch the network.',
    icon: Building2,
    scope: 'PLATFORM',
    role: 'PLATFORM_ADMIN',
    findHere: [
      ['Brands', 'Onboarding progress and last activity for every brand.'],
      ['Network health', 'Counts only. Customer data is never shown here.'],
      ['Audit', 'Every platform action, who did it and why.'],
    ],
  },
};
const ORDER: LoginAs[] = ['brand', 'store', 'platform'];

export const SCOPE_TO_LOGIN_AS: Record<Scope, LoginAs> = { BRAND: 'brand', RETAIL: 'store', PLATFORM: 'platform' };
export const loginAsScope = (as: LoginAs): Scope => ROLES[as].scope;

const parseAs = (value: string | null): LoginAs =>
  value === 'store' || value === 'platform' || value === 'brand' ? value : 'brand';

export function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const as = parseAs(params.get('as'));
  const copy = ROLES[as];
  const from = (location.state as { from?: string } | null)?.from ?? '/app';
  const demo = useDemoConfig();
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Also reached right after a successful sign-in (Firebase updates the user before signIn()
  // resolves): carry the chosen role so /app can explain a different account's console.
  if (!loading && user) return <Navigate to={from} replace state={{ as: copy.scope }} />;

  const choose = (next: LoginAs) => {
    setParams({ as: next }, { replace: true, state: location.state });
    setError(null);
  };
  const onKey = (e: KeyboardEvent, index: number) => {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + ORDER.length) % ORDER.length;
    radios.current[next]?.focus();
    choose(ORDER[next]!);
  };

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      // The backend decides the scope; /app compares it with the tab and explains a mismatch.
      navigate(from, { replace: true, state: { as: copy.scope } });
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const demoLogins = demo.logins.filter((l) => l.role === copy.role);
  const Icon = copy.icon;

  return (
    <div className="login">
      <header className="login__header">
        <Link to="/" className="login__home" aria-label="Qwikspot home">
          <Wordmark />
        </Link>
        <Link to="/" className="login__back">
          <ArrowLeft size={16} aria-hidden="true" /> Back to home
        </Link>
      </header>
      <main className="login__main">
        <section className="login__card" aria-labelledby="login-heading">
          <div className="login__segments" role="radiogroup" aria-label="Sign in as">
            {ORDER.map((key, i) => (
              <button
                key={key}
                ref={(el) => {
                  radios.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={key === as}
                tabIndex={key === as ? 0 : -1}
                className="login__segment"
                onClick={() => choose(key)}
                onKeyDown={(e) => onKey(e, i)}
              >
                {ROLES[key].tab}
              </button>
            ))}
          </div>
          <h1 id="login-heading">{copy.heading}</h1>
          <p className="login__line">{copy.line}</p>
          <form onSubmit={onSubmit} className="login__form">
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <Button type="submit" loading={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
          {copy.noAccount && <p className="login__note">{copy.noAccount}</p>}
          <DemoLoginPanel
            logins={demoLogins}
            onUse={(login) => {
              setEmail(login.email);
              setPassword(login.password);
              setError(null);
            }}
          />
        </section>
        <aside className="login__aside" aria-label="What you'll find here">
          <span className="login__aside-icon" aria-hidden="true">
            <Icon size={22} />
          </span>
          <h2>What you&apos;ll find here</h2>
          <ul>
            {copy.findHere.map(([title, text]) => (
              <li key={title}>
                <strong>{title}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
  );
}
