import { ArrowRight, Store, Tags } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/authContext';
import { Wordmark } from '../../components/shell/Wordmark';

/**
 * Public landing page ("/"). UI-0 placeholder: the pitch in one sentence and the two
 * doors. The full one-scroll landing page is UI-1. Needs no sign-in and no API call.
 */
export function LandingPage() {
  const { user } = useAuth();
  return (
    <div className="landing">
      <header className="landing__header">
        <Wordmark />
        <nav className="landing__actions" aria-label="Sign in">
          {user ? (
            <Link className="ui-button ui-button--primary" to="/app">
              Go to your console <ArrowRight size={16} aria-hidden="true" />
            </Link>
          ) : (
            <>
              <Link className="ui-button ui-button--ghost" to="/login?as=brand">
                Brand login
              </Link>
              <Link className="ui-button ui-button--secondary" to="/login?as=store">
                Store login
              </Link>
            </>
          )}
        </nav>
      </header>
      <main className="landing__hero">
        <h1>Your shopper wants it today. Your partner store has it.</h1>
        <p>
          Qwikspot catches buying intent on your website, continues the conversation on WhatsApp in your brand&apos;s
          name, and holds the product at the nearest partner store that actually has it.
        </p>
        <div className="landing__doors">
          <Link className="ui-button ui-button--accent" to="/login?as=brand">
            <Tags size={18} aria-hidden="true" />
            I&apos;m a brand
          </Link>
          <Link className="ui-button ui-button--secondary" to="/login?as=store">
            <Store size={18} aria-hidden="true" />I run a store
          </Link>
        </div>
      </main>
      <footer className="landing__footer">
        <Link to="/login?as=platform">Qwikspot team sign-in</Link>
      </footer>
    </div>
  );
}
