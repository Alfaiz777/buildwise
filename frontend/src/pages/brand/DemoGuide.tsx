import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { errorMessage, useLoad } from '../../components/ConsoleShell';

interface ResetResult {
  catalog: { products: number; variants: number };
  stock: { status: string; rows_valid: number };
  history: Record<string, number>;
}

/**
 * The judge's guide (Change 14, G3/G4), shown only to the shared demo brand's Brand Admin
 * when DEMO_MODE is on: six steps through the product, each with a button, and "Reset demo".
 */
export function DemoGuide({ demoStorefront }: { demoStorefront: boolean }) {
  const api = useApi();
  const demo = useLoad(useCallback(() => api.get<{ reset_available: boolean }>('/api/brand/demo'), [api]));
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!demo.data?.reset_available) return null;

  const reset = async () => {
    setResetting(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.post<ResetResult>('/api/brand/demo/reset', {});
      setResult(
        `Demo reset: ${r.catalog.products} products synced, store stock restored, ` +
          `${r.history.outcomes ?? 0} synthetic outcomes rebuilt. Reload other tabs to see it.`,
      );
      setConfirming(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setResetting(false);
    }
  };

  const newTab = { target: '_blank', rel: 'noopener noreferrer' } as const;

  return (
    <details className="demo-guide" open>
      <summary>
        <strong>Demo guide</strong> <span className="muted small">— 6 steps, about 10 minutes, synthetic data</span>
      </summary>
      <ol>
        <li>
          <strong>Shop like a customer.</strong> Choose Vitamin C Glow Serum 30 ml and tap{' '}
          <em>Need it today? Check a store near you</em>. The WhatsApp hand-off opens the simulator in a new tab with
          the message ready (sign in there as the Brand Admin if asked).{' '}
          {demoStorefront ? (
            <a href="/shop" {...newTab}>
              Open the demo store
            </a>
          ) : (
            <span className="muted">Use the brand's storefront.</span>
          )}
        </li>
        <li>
          <strong>Ask for a store.</strong> Send the message, then <em>Share location → Near Powai → Send location</em>.
          Powai is out of stock, so the assistant offers Andheri. Tap <em>Hold at Andheri</em>.{' '}
          <Link to="/brand/conversations">Open the simulator</Link>
        </li>
        <li>
          <strong>See why.</strong> Select the conversation: the decision trace shows the eligible and excluded stores,
          the guardrail's fresh re-check and every tool call. <Link to="/brand/conversations">Conversations</Link>
        </li>
        <li>
          <strong>Fulfil in store.</strong> In a new tab, sign in as <em>Retail Admin — Andheri Store</em>: Confirm →
          Ready → Customer arrived → Complete with the pickup code the customer received.{' '}
          <a href="/login" {...newTab}>
            Open a new sign-in tab
          </a>
        </li>
        <li>
          <strong>Measure the outcome.</strong> The pickup counts as an in-store purchase; read the weekday insight
          built from four weeks of flagged synthetic history. <Link to="/brand/outcomes">Outcomes &amp; insights</Link>
        </li>
        <li>
          <strong>Follow up.</strong> On the demo store, sign in as a demo shopper, <em>Add to cart</em> and leave.
          After about two minutes, <em>Run due follow-ups</em> sends a cart-abandonment follow-up.{' '}
          <Link to="/brand/conversations">Conversations</Link>
        </li>
      </ol>

      <div className="inline">
        <button type="button" className="secondary" onClick={() => setConfirming(true)} disabled={resetting}>
          Reset demo
        </button>
        <span className="muted small">Back to the seeded state: stock, catalogue and history.</span>
      </div>
      {confirming && (
        <div role="alertdialog" aria-labelledby="reset-title" aria-describedby="reset-desc" className="notice">
          <p id="reset-title">
            <strong>This resets the shared demo for everyone.</strong>
          </p>
          <p id="reset-desc">
            All conversations, reservations and outcomes of this demo brand are deleted, and the stock, catalogue and
            synthetic history are rebuilt. Accounts, stores and the audit log stay. Anyone using the demo right now will
            see their session disappear.
          </p>
          <div className="inline">
            <button type="button" onClick={() => void reset()} disabled={resetting}>
              {resetting ? 'Resetting…' : 'Yes, reset the demo'}
            </button>
            <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={resetting}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {result && (
        <p role="status" className="notice">
          {result}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </details>
  );
}
