import { Link } from 'react-router-dom';
import { Wordmark } from '../../components/shell/Wordmark';

/** Shown where the shopper demo is not served (gcp without DEMO_MODE). No other API call. */
export function ShopperUnavailable() {
  return (
    <main className="card shopper-unavailable">
      <Wordmark />
      <h1>The shopper demo isn&apos;t available here.</h1>
      <p className="muted">
        This deployment does not run the public demo. Brands and stores can still sign in to their consoles.
      </p>
      <Link to="/">Back to Qwikspot</Link>
    </main>
  );
}
