import { useCallback, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useApi, type Store } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { QUEUE_CHANGED } from '../../components/shell/AppShell';
import { Card, ErrorState, KpiTile, ProductThumb, Skeleton, useToast } from '../../components/ui';
import { label } from '../../lib/labels';
import { formatDateTime, formatPrice } from '../brand/types';
import { itemLabel, RetailerQueue, type QueueReservation } from './RetailerQueue';
import { playNewHoldTone, useNewHoldTitle, useStoreSound } from './storeAlert';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function hoursText(hours: Store['store_hours']): string | null {
  if (!hours) return null;
  const days = WEEKDAYS.filter((d) => hours[d]).map((d) => `${d.slice(0, 3)} ${hours[d]}`);
  if (days.length === 0) return null;
  return `${days.join(' · ')}${hours.timezone ? ` (${hours.timezone})` : ''}`;
}

export interface WeekSummary {
  days: number;
  reservations: number;
  completed: number;
  refused: number;
  expired: number;
  completion_pct?: number | null;
  value?: { amount: number; currency: string };
  synthetic?: number;
}

/** The signed-in store, or a redirect for anyone else (the backend decides the scope). */
function useStoreMe() {
  const me = useMe();
  return me.scope === 'RETAIL' ? me : null;
}

/**
 * The store's value strip (Change 16, UI-4): the last 7 days of its holds. Completion is
 * picked up ÷ finished holds; the value uses the store's current offline prices ("est.").
 */
export function ValueStrip({ storeId, reloadKey }: { storeId: string; reloadKey: number }) {
  const api = useApi();
  const summary = useLoad(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useCallback(
      () => api.get<WeekSummary>(`/api/retail/stores/${encodeURIComponent(storeId)}/summary`),
      [api, storeId, reloadKey],
    ),
  );
  const s = summary.data;
  if (!s) return summary.error ? <p className="error small">{summary.error}</p> : <Skeleton lines={1} />;
  const synthetic = (s.synthetic ?? 0) > 0;
  return (
    <section aria-label="Last 7 days">
      <h2 className="strip-title">Last 7 days</h2>
      <div className="kpi-grid kpi-grid--store">
        <KpiTile label="Holds" value={s.reservations} sub="sent to you" synthetic={synthetic} />
        <KpiTile label="Picked up" value={s.completed} sub="collected in store" synthetic={synthetic} />
        <KpiTile
          label="Completion"
          value={s.completion_pct === null || s.completion_pct === undefined ? '—' : `${s.completion_pct}%`}
          sub="of finished holds"
          synthetic={synthetic}
        />
        <KpiTile label="Refused" value={s.refused} synthetic={synthetic} />
        <KpiTile label="Expired" value={s.expired} sub="not collected" synthetic={synthetic} />
        {s.value && (
          <KpiTile
            label="Value of pickups"
            value={formatPrice(s.value.amount, s.value.currency)}
            sub="at your current prices"
            estimated
            synthetic={synthetic}
          />
        )}
      </div>
      {synthetic && (
        <p className="muted small">
          {s.synthetic} of these {s.reservations} holds are synthetic demo history.
        </p>
      )}
    </section>
  );
}

/**
 * Store Console → Today (docs/11 §5; Change 16, UI-4): the value strip, the "Next up"
 * card and the queue. A new hold raises a toast, a "New" badge and the tab title; a short
 * tone only if the store switched sound on. Exactly ONE store — the one the backend
 * verified at sign-in; no store picker, no other store of the retailer.
 */
export function RetailerHome({ autoPoll = false }: { autoPoll?: boolean }) {
  const me = useStoreMe();
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const [sound, setSound] = useStoreSound();
  const [unseen, setUnseen] = useState(0);
  useNewHoldTitle(unseen);
  if (!me) return <Navigate to="/app" replace />;

  const onNewHolds = (arrived: QueueReservation[]) => {
    setUnseen((n) => n + arrived.length);
    toast.show(
      arrived.length === 1
        ? `New hold: ${itemLabel(arrived[0]!)} — confirm it`
        : `${arrived.length} new holds — confirm them`,
      'info',
    );
    if (sound) playNewHoldTone();
    setReloadKey((k) => k + 1);
    window.dispatchEvent(new Event(QUEUE_CHANGED));
  };

  return (
    <ConsoleShell>
      <div onClick={() => unseen && setUnseen(0)} onKeyDown={() => unseen && setUnseen(0)} role="presentation">
        <ValueStrip storeId={me.store.store_id} reloadKey={reloadKey} />
        <div className="today-tools">
          <label className="small sound-toggle">
            <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sound for new holds
          </label>
          {autoPoll && <span className="muted small">New holds appear automatically (checked every 15 seconds).</span>}
        </div>
        <RetailerQueue
          view="active"
          autoPoll={autoPoll}
          brandName={me.brand_name}
          onNewHolds={onNewHolds}
          onChanged={() => {
            setReloadKey((k) => k + 1);
            window.dispatchEvent(new Event(QUEUE_CHANGED));
          }}
        />
      </div>
    </ConsoleShell>
  );
}

/** Store Console → History: finished holds and how they ended. */
export function StoreHistory() {
  const me = useStoreMe();
  if (!me) return <Navigate to="/app" replace />;
  return (
    <ConsoleShell>
      <Card title="History" description="Holds that were picked up, refused, cancelled or expired.">
        <RetailerQueue view="history" autoPoll={false} brandName={me.brand_name} />
      </Card>
    </ConsoleShell>
  );
}

interface StockItem {
  sku: string;
  product_title: string | null;
  variant_title: string | null;
  image_url?: string | null;
  quantity: number;
  reserved_quantity: number;
  available_quantity: number;
  availability_status: string;
  last_updated_at: string | null;
  stale?: boolean;
}

/** Store Console → Stock: read-only, from the brand's retail file; plus the store's details. */
export function StoreStock({ autoPoll = false }: { autoPoll?: boolean }) {
  const me = useStoreMe();
  const api = useApi();
  const storeId = me?.store.store_id ?? '';
  const stock = useLoad(
    useCallback(
      () => api.get<{ items: StockItem[] }>(`/api/retail/stores/${encodeURIComponent(storeId)}/inventory`),
      [api, storeId],
    ),
  );
  if (!me) return <Navigate to="/app" replace />;
  const store = me.store;
  return (
    <ConsoleShell>
      <Card
        title="Stock"
        description="Your brand updates this from its retail file. You can't edit it here."
        actions={
          <button type="button" className="secondary" onClick={stock.reload}>
            Refresh
          </button>
        }
      >
        {stock.error && <ErrorState message={stock.error} onRetry={stock.reload} />}
        {!stock.data && !stock.error && <Skeleton lines={4} label="Loading stock" />}
        {stock.data?.items.some((i) => i.stale) && (
          <p className="notice small" role="status">
            Some stock rows are out of date. Customers are told when the stock was last updated; ask your brand to
            import a fresh retail file.
          </p>
        )}
        {stock.data?.items.length === 0 ? (
          <p className="muted">
            No stock has been imported for this store yet. Your brand imports it from its retail file.
          </p>
        ) : (
          stock.data && (
            <div className="ui-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">SKU</th>
                    <th scope="col">Quantity</th>
                    <th scope="col">Reserved</th>
                    <th scope="col">Available</th>
                    <th scope="col">Stock as of</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.data.items.map((item) => (
                    <tr key={item.sku}>
                      <td>
                        <span className="cell-product">
                          <ProductThumb src={item.image_url ?? null} name={item.product_title ?? item.sku} size={36} />
                          <span>
                            {item.product_title ?? '—'}
                            {item.variant_title && <span className="muted small"> · {item.variant_title}</span>}
                          </span>
                        </span>
                      </td>
                      <td className="mono">{item.sku}</td>
                      <td>{item.quantity}</td>
                      <td>{item.reserved_quantity}</td>
                      <td>
                        {item.available_quantity}{' '}
                        {item.availability_status !== 'IN_STOCK' && (
                          <span className="badge">{label(item.availability_status)}</span>
                        )}
                      </td>
                      <td className="small">
                        {formatDateTime(item.last_updated_at)}{' '}
                        {item.stale && <span className="badge stale">stale</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        <p className="muted small">
          Reserved = units held for customers at this store (released when a hold is cancelled or expires); available =
          quantity − reserved.{autoPoll ? ' Refreshes when you press Refresh.' : ''}
        </p>
      </Card>
      <Card title="Your store">
        <dl className="settings-list">
          <dt>Store</dt>
          <dd>
            {store.store_name} <span className="muted small mono">{store.store_id}</span>
          </dd>
          <dt>Retailer</dt>
          <dd>{me.retailer_name}</dd>
          <dt>Brand</dt>
          <dd>{me.brand_name}</dd>
          <dt>City</dt>
          <dd>{store.city}</dd>
          <dt>Address</dt>
          <dd>{store.address ?? <span className="muted">not provided</span>}</dd>
          <dt>Status</dt>
          <dd>{label(store.store_status)}</dd>
          <dt>Hours</dt>
          <dd>{hoursText(store.store_hours) ?? <span className="muted">not provided</span>}</dd>
        </dl>
      </Card>
    </ConsoleShell>
  );
}
