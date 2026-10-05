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
 * The judge's guide (Change 14, G3/G4; UI-6), shown only to the shared demo brand's Brand
 * Admin when DEMO_MODE is on: the 10-minute judge script (the same 8 steps as the README and
 * scripts/judge-script.mjs), each with its link, and "Reset demo".
 */
export function DemoGuide({ brandId }: { brandId: string }) {
  const shopUrl = `/shop?brand=${encodeURIComponent(brandId)}`;
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
        <strong>Demo guide</strong>{' '}
        <span className="muted small">— the 10-minute judge script, 8 steps, synthetic data</span>
      </summary>
      <ol>
        <li>
          <strong>See it as a shopper.</strong> Open the brand&apos;s demo store.{' '}
          <a href={shopUrl} {...newTab}>
            Open the shopper demo
          </a>
        </li>
        <li>
          <strong>Need it today?</strong> Open Vitamin C Glow Serum, 30 ml, tap{' '}
          <em>Need it today? Check a store near you</em> and send the message that is ready in the chat.
        </li>
        <li>
          <strong>Pick up today.</strong> In the chat, <em>📍 → Near Powai</em>. Powai is out of stock, so the assistant
          offers &quot;Pick up today at Andheri Store, 7.6 km&quot; next to &quot;Home delivery in 4–5 days&quot;. Tap{' '}
          <em>Pick up today</em>: the pickup pass and the store&apos;s location arrive.
        </li>
        <li>
          <strong>Fulfil in store.</strong> In a new tab, sign in as <em>Retail Admin — Andheri Store</em>: Confirm →
          Mark ready → Customer arrived → Complete with the pickup code from the chat. Confirm and Mark ready appear in
          the shopper&apos;s chat, and Complete sends one short thank-you.{' '}
          <a href="/login?as=store" {...newTab}>
            Open a store sign-in tab
          </a>
        </li>
        <li>
          <strong>See the journey and why.</strong> Here, the conversation&apos;s timeline ends &quot;Picked up at
          Andheri Store — in-store purchase&quot;, with one sentence on why Andheri was offered.{' '}
          <Link to="/brand/conversations">Conversations</Link>
        </li>
        <li>
          <strong>Measure it.</strong> The funnel, the weekday reading and suggestions, built from four weeks of flagged
          synthetic history. <Link to="/brand/insights">Insights</Link>
        </li>
        <li>
          <strong>Follow up.</strong> In the shop&apos;s <em>Demo controls</em>, sign in as Asha (opted in), add the
          serum to the bag and leave. About three minutes later the follow-up reaches Asha&apos;s chat — by itself while
          Conversations is open (it runs due work every 30 s), or when you press <em>Process due work now</em>. Each
          sign-in is its own synthetic customer. <Link to="/brand/conversations">Conversations</Link>
        </li>
        <li>
          <strong>The platform view.</strong> Sign in as the Qwikspot team to see the network as aggregates — never a
          customer.{' '}
          <a href="/login?as=platform" {...newTab}>
            Open a platform sign-in tab
          </a>
        </li>
      </ol>

      <div className="inline">
        <button type="button" className="secondary" onClick={() => setConfirming(true)} disabled={resetting}>
          Reset demo
        </button>
        <span className="muted small">
          Back to the seeded state: stock, catalogue and history; every judge&apos;s chats and demo shoppers are
          removed.
        </span>
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
