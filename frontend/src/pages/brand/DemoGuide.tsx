import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { errorMessage, useLoad } from '../../components/ConsoleShell';
import { Button, ConfirmDialog } from '../../components/ui';
import type { ShopifyStore } from './shopifyStore';

interface ResetResult {
  /** L1: the brand's Shopify store is not connected yet — the catalogue waits for it. */
  pending?: 'SHOPIFY_NOT_CONNECTED' | null;
  catalog: { products: number; variants: number };
  stock: { status: string; rows_valid: number };
  history: Record<string, number>;
}

/**
 * The judge's guide (Change 14, G3/G4; UI-6; Shopify flow), shown only to the shared demo
 * brand's Brand Admin when DEMO_MODE is on: the 10-minute judge script on the brand's real
 * Shopify store and WhatsApp, each step with its link, and "Reset demo".
 */
export function DemoGuide({ store }: { store: ShopifyStore | null }) {
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
        r.pending === 'SHOPIFY_NOT_CONNECTED'
          ? 'Demo reset: stores restored. Connect your Shopify store (Settings → Shopify), then press Reset demo again to load the catalogue and history.'
          : `Demo reset: ${r.catalog.products} products synced, store stock restored, ` +
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
    // UI-P3: inside the "Try the live demo" checklist, closed until opened.
    <details className="demo-guide">
      <summary>
        <strong>Demo guide</strong> <span className="muted small">— the full 10-minute judge script, 8 steps</span>
      </summary>
      <ol>
        <li>
          <strong>Open the store.</strong>{' '}
          {store ? (
            <>
              <a href={store.url} {...newTab}>
                Open the {store.name ?? 'Shopify'} store
              </a>{' '}
              — or scan the QR next to “Open store” at the top of this console with your phone.
            </>
          ) : (
            'Connect the Shopify store first (Settings → Shopify).'
          )}
        </li>
        <li>
          <strong>Need it today?</strong> Open a product (e.g. Vitamin C Glow Serum), pick a size and tap{' '}
          <em>Need it today? Ask on WhatsApp</em>. On a phone WhatsApp opens; on a computer, scan the QR under the
          button and WhatsApp opens on your phone. Send the message that is ready.
        </li>
        <li>
          <strong>Pick up today.</strong> Reply with your area, e.g. <em>Satellite</em> (or share your location). The
          assistant lists the stores with stock, nearest first, next to home delivery. Tap a store: the pickup pass and
          its location arrive. <em>Other stores</em> lists the whole area.
        </li>
        <li>
          <strong>Fulfil in store.</strong> In a new tab, sign in as <em>Retail Admin — Wellness Mart, Satellite</em>:
          Confirm → Mark ready → Customer arrived → Complete with the pickup code from the chat. Confirm and Mark ready
          appear in the shopper&apos;s chat, and Complete sends one short thank-you.{' '}
          <a href="/login?as=store" {...newTab}>
            Open a store sign-in tab
          </a>
        </li>
        <li>
          <strong>See the journey and why.</strong> Here, the conversation&apos;s timeline ends &quot;Picked up at
          Wellness Mart — in-store purchase&quot;, with one sentence on why Wellness Mart was offered.{' '}
          <Link to="/brand/conversations">Conversations</Link>
        </li>
        <li>
          <strong>Measure it.</strong> The funnel, the weekday reading and suggestions, built from four weeks of flagged
          synthetic history. <Link to="/brand/insights">Insights</Link>
        </li>
        <li>
          <strong>Follow up.</strong> On the same browser, add a product to the cart in the store and leave. A few
          minutes later the follow-up arrives in your WhatsApp — press <em>Process due work now</em> in Conversations to
          send it at once. Writing to the brand on WhatsApp counts as opting in; reply STOP to opt out.{' '}
          <Link to="/brand/conversations">Conversations</Link>
        </li>
        <li>
          <strong>The platform view.</strong> Sign in as the Qwikspot team to see the network as aggregates — never a
          customer.{' '}
          <a href="/login?as=platform" {...newTab}>
            Open a platform sign-in tab
          </a>
        </li>
      </ol>

      <div className="demo-guide__reset">
        <Button variant="secondary" size="sm" onClick={() => setConfirming(true)} disabled={resetting}>
          Reset demo
        </Button>
        <span className="muted small">
          Back to the seeded state: stock, catalogue and history; every judge&apos;s chats and demo shoppers are
          removed.
        </span>
      </div>
      <ConfirmDialog
        open={confirming}
        title="This resets the shared demo for everyone."
        confirmLabel="Yes, reset the demo"
        tone="danger"
        busy={resetting}
        onConfirm={() => void reset()}
        onCancel={() => setConfirming(false)}
      >
        All conversations, reservations and outcomes of this demo brand are deleted, and the stock, catalogue and
        synthetic history are rebuilt. Accounts, stores and the audit log stay. Anyone using the demo right now will see
        their session disappear.
      </ConfirmDialog>
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
