import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApi } from '../../api/apiContext';
import { errorMessage, useLoad } from '../../components/ConsoleShell';
import { Badge, Button, Card, ConfirmDialog, useToast } from '../../components/ui';
import { formatDateTime, type Connection } from './types';

/** The callback's `reason` codes in plain words (L2-Shopify; docs/06 §9). */
export const SHOPIFY_ERROR_WORDS: Record<string, string> = {
  INVALID_HMAC: 'Shopify’s reply could not be verified. Try connecting again.',
  INVALID_STATE: 'That connection link was already used or is not valid. Try connecting again.',
  STATE_EXPIRED: 'The connection link expired after 10 minutes. Try connecting again.',
  SHOP_MISMATCH: 'Shopify answered for a different store than the one you entered. Try again.',
  TOKEN_EXCHANGE_FAILED: 'Shopify did not grant access. Try connecting again.',
  SHOP_ALREADY_CONNECTED: 'That Shopify store is already connected to another brand.',
  WEBHOOKS_FAILED: 'Connected, but Shopify did not accept the order notifications. Connect again to retry.',
};

/**
 * Brand Console → Settings → Shopify (L2-Shopify). Mock mode: the local mock catalogue
 * with "Sync products". Shopify mode: connect with the store's myshopify.com domain (the
 * browser only ever sees Shopify's authorize URL), then the store's name, last sync,
 * product count, "Sync products" and "Disconnect". Returning from Shopify shows a toast
 * and cleans the query string.
 */
export function ShopifyCard({
  provider,
  navigate = (url) => window.location.assign(url),
}: {
  provider: 'MOCK' | 'SHOPIFY';
  /** Leaves for Shopify's authorize page (injectable for tests). */
  navigate?: (url: string) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const connections = useLoad(
    useCallback(() => api.get<{ connections: Connection[] }>('/api/brand/connections'), [api]),
  );
  const [shop, setShop] = useState('');
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Back from Shopify: ?shopify=connected | ?shopify=error&reason=…
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('shopify');
    if (!result) return;
    if (result === 'connected') toast.show('Shopify connected');
    else toast.show(SHOPIFY_ERROR_WORDS[params.get('reason') ?? ''] ?? 'Shopify could not be connected.', 'error');
    params.delete('shopify');
    params.delete('reason');
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
  }, [toast]);

  const c = connections.data?.connections.find((x) => x.provider === 'SHOPIFY') ?? null;
  const connected = provider === 'SHOPIFY' ? c?.status === 'CONNECTED' || c?.status === 'ERROR' : true;
  const live = provider === 'SHOPIFY' && c && c.status !== 'DISCONNECTED' && c.source === 'SHOPIFY';

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('connect');
    setError(null);
    try {
      const res = await api.post<{ authorize_url: string }>('/api/integrations/shopify/connect', { shop: shop.trim() });
      navigate(res.authorize_url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('sync');
    setError(null);
    try {
      const r = await api.post<Connection>('/api/integrations/shopify/sync', {});
      toast.show(`Products synced: ${r.product_count} products.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      connections.reload();
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    setError(null);
    try {
      await api.post('/api/integrations/shopify/disconnect', {});
      toast.show('Shopify disconnected');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      setConfirming(false);
      connections.reload();
    }
  };

  return (
    <Card
      title="Shopify"
      description={
        provider === 'MOCK'
          ? 'This server uses the local mock catalogue (COMMERCE_PROVIDER=mock).'
          : 'Your online store: products come from Shopify, and orders placed through a chat link are counted.'
      }
    >
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {provider === 'MOCK' || (live && connected) ? (
        <>
          <dl className="settings-list">
            {provider === 'SHOPIFY' && c && (
              <>
                <dt>Store</dt>
                <dd>
                  <strong>{c.shop_name ?? c.shop_domain}</strong>{' '}
                  <span className="muted small mono">{c.shop_domain}</span>{' '}
                  {c.status === 'ERROR' ? (
                    <Badge tone="warning">Needs attention</Badge>
                  ) : (
                    <Badge tone="success">Connected</Badge>
                  )}
                </dd>
              </>
            )}
            {provider === 'MOCK' && (
              <>
                <dt>Catalogue</dt>
                <dd>Mock (local)</dd>
              </>
            )}
            <dt>Last sync</dt>
            <dd>{formatDateTime(c?.last_sync_at ?? null)}</dd>
            <dt>Products</dt>
            <dd>{c?.last_sync_at ? `${c.product_count} products · ${c.variant_count} variants` : 'Not synced yet'}</dd>
            {c?.last_error && (
              <>
                <dt>Last error</dt>
                <dd className="warn-text">
                  {c.last_error.code === 'SHOPIFY_RECONNECT_REQUIRED'
                    ? 'Shopify no longer accepts this connection. Disconnect and connect again.'
                    : c.last_error.message}
                </dd>
              </>
            )}
          </dl>
          <div className="inline-actions">
            <Button onClick={() => void sync()} disabled={busy !== null}>
              {busy === 'sync' ? 'Syncing…' : 'Sync products'}
            </Button>
            {provider === 'SHOPIFY' && (
              <Button variant="secondary" onClick={() => setConfirming(true)} disabled={busy !== null}>
                Disconnect
              </Button>
            )}
          </div>
        </>
      ) : (
        <form className="inline shopify-connect" onSubmit={(e) => void connect(e)}>
          <label htmlFor="shopify-shop">Store domain</label>
          <input
            id="shopify-shop"
            name="shop"
            value={shop}
            onChange={(e) => setShop(e.target.value)}
            placeholder="m6ccxz-wk.myshopify.com"
            autoComplete="off"
            spellCheck={false}
            required
          />
          <Button type="submit" disabled={busy !== null || !shop.trim()}>
            {busy === 'connect' ? 'Opening Shopify…' : 'Connect Shopify'}
          </Button>
        </form>
      )}
      <ConfirmDialog
        open={confirming}
        title="Disconnect Shopify?"
        confirmLabel="Disconnect"
        tone="danger"
        busy={busy === 'disconnect'}
        onConfirm={() => void disconnect()}
        onCancel={() => setConfirming(false)}
      >
        Qwikspot stops reading products and orders from {c?.shop_name ?? 'your store'}. Synced products stay; you can
        connect again at any time.
      </ConfirmDialog>
    </Card>
  );
}
