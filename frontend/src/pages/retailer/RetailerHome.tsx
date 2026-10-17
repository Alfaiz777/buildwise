import { Bell, BellOff, MapPin, Search, Store as StoreIcon, Tag } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useApi, type Store } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { QUEUE_CHANGED } from '../../components/shell/AppShell';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  MiniFunnel,
  ProductThumb,
  ProgressBar,
  RingGauge,
  Skeleton,
  StatusPill,
  Tip,
  useToast,
} from '../../components/ui';
import { formatDateTime, formatPrice } from '../brand/types';
import { AiBriefCard } from '../brand/AiCards';
import { ago, AskAction, PageHeader } from '../platform/PlatformChrome';
import { itemLabel, RetailerQueue, storeTime, type QueueReservation } from './RetailerQueue';
import { playNewHoldTone, useNewHoldTitle, useStoreSound } from './storeAlert';
import { storeBriefPath } from './storeAsk';
import './store.css';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALL_DAY = /^0?0:00\s*[-–]\s*23:59$/;

/**
 * Store hours in plain words (UI-P2): "Open 24 hours, every day" when every day is
 * 00:00–23:59; otherwise consecutive days with the same hours grouped — "Mon–Sat 10:00–21:00 ·
 * Sun closed" (a day without hours is closed).
 */
export function hoursText(hours: Store['store_hours']): string | null {
  if (!hours) return null;
  const per = WEEKDAYS.map((d) => hours[d]?.trim() || null);
  if (per.every((h) => h === null)) return null;
  if (per.every((h) => h !== null && ALL_DAY.test(h))) return 'Open 24 hours, every day';
  const groups: { from: number; to: number; hours: string | null }[] = [];
  per.forEach((h, i) => {
    const last = groups.at(-1);
    if (last && last.hours === h) last.to = i;
    else groups.push({ from: i, to: i, hours: h });
  });
  return groups
    .map((g) => {
      const days = g.from === g.to ? SHORT[g.from] : `${SHORT[g.from]}–${SHORT[g.to]}`;
      const text = g.hours === null ? 'closed' : ALL_DAY.test(g.hours) ? 'open 24 hours' : g.hours.replace('-', '–');
      return `${days} ${text}`;
    })
    .join(' · ');
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
 * The store's value strip (Change 16, UI-4; UI-P2 tiles): the last 7 days of its holds.
 * Completion is picked up ÷ finished holds; the value uses the store's current offline prices
 * ("est."). One page-level badge says when demo history is included.
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
  const synthetic = s.synthetic ?? 0;
  const pct = s.completion_pct ?? null;
  return (
    <section aria-label="Last 7 days" className="st-strip">
      <div className="st-strip__head">
        <h2 className="strip-title">Last 7 days</h2>
        {synthetic > 0 && (
          <Tip text={`${synthetic} of these ${s.reservations} holds are synthetic demo history.`}>
            <Badge tone="neutral">
              Includes demo history · {synthetic} of {s.reservations} holds
            </Badge>
          </Tip>
        )}
      </div>
      <div className="st-tiles">
        <div className="pf-tile pf-tile--lg">
          <span className="pf-tile__label">Holds → Picked up</span>
          <span className="pf-tile__value">
            {s.reservations} <span className="pf-tile__arrow">→</span> {s.completed}
          </span>
          <MiniFunnel from={s.reservations} to={s.completed} />
          <span className="pf-tile__sub">sent to you → collected in store</span>
        </div>
        <div className="pf-tile pf-tile--lg pf-tile--ring">
          <RingGauge pct={pct} size={56} />
          <div>
            <span className="pf-tile__label">Completion</span>
            <span className="pf-tile__value">{pct === null ? '—' : `${pct}%`}</span>
            <span className="pf-tile__sub">of finished holds</span>
          </div>
        </div>
        <div className="pf-tile pf-tile--lg">
          <span className="pf-tile__label">Value of pickups</span>
          <span className="pf-tile__value">
            {s.value ? formatPrice(s.value.amount, s.value.currency) : '—'}
            {s.value && <span className="pf-tile__est">est.</span>}
          </span>
          <span className="pf-tile__sub">at your current prices</span>
        </div>
      </div>
      <div className="st-tiles st-tiles--small">
        <div className="pf-tile">
          <span className="pf-tile__label">Refused</span>
          <span className="pf-tile__value pf-tile__value--sm">{s.refused}</span>
          <span className="pf-tile__sub">holds you turned down</span>
        </div>
        <div className="pf-tile">
          <span className="pf-tile__label">Expired</span>
          <span className="pf-tile__value pf-tile__value--sm">{s.expired}</span>
          <span className="pf-tile__sub">not collected in time</span>
        </div>
      </div>
    </section>
  );
}

/** "Last hold: 14:05 yesterday" under the all-caught-up state (from the store's own history). */
function LastHold() {
  const api = useApi();
  const last = useLoad(
    useCallback(() => api.get<{ reservations: QueueReservation[] }>('/api/reservations?view=history'), [api]),
  );
  const r = [...(last.data?.reservations ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!r) return null;
  return (
    <p className="small muted">
      Last hold: {storeTime(r.created_at, r.store_timezone)}, {ago(r.created_at)}
    </p>
  );
}

/** The new-hold sound as a switch (the same remembered setting). */
function SoundSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <Tip text={on ? 'A short tone plays when a new hold arrives.' : 'No sound — new holds still show a toast.'}>
      <label className={`st-switch${on ? ' is-on' : ''}`}>
        {on ? <Bell size={16} aria-hidden="true" /> : <BellOff size={16} aria-hidden="true" />}
        <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span className="st-switch__track" aria-hidden="true" />
        <span className="sr-only">Sound for new holds</span>
      </label>
    </Tip>
  );
}

/**
 * Store Console → Today (docs/11 §5; Change 16, UI-4; UI-P2 layout): the holds hero first —
 * who is waiting and the one thing to do next — then the AI brief and the last 7 days. A new
 * hold raises a toast, a "New" badge, a slide-in and the tab title; a short tone only if the
 * store switched sound on. Exactly ONE store — the one the backend verified at sign-in.
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
      <div
        className="st-page"
        onClick={() => unseen && setUnseen(0)}
        onKeyDown={() => unseen && setUnseen(0)}
        role="presentation"
      >
        <PageHeader
          title="Today"
          purpose="Who is waiting for you, and what to do next."
          action={<AskAction label="Which holds are waiting?" question="Which holds are waiting for me?" />}
        />
        <Card className="st-hero">
          <RetailerQueue
            view="active"
            autoPoll={autoPoll}
            brandName={me.brand_name}
            onNewHolds={onNewHolds}
            tools={<SoundSwitch on={sound} onChange={setSound} />}
            empty={<LastHold />}
            onChanged={() => {
              setReloadKey((k) => k + 1);
              window.dispatchEvent(new Event(QUEUE_CHANGED));
            }}
          />
        </Card>
        {/* L6: loads after the page; Gemini's brief, or the rules text when Gemini is slow. */}
        <AiBriefCard url={storeBriefPath(me.store.store_id)} title="Today at your store" days={7} includeHistory />
        <ValueStrip storeId={me.store.store_id} reloadKey={reloadKey} />
      </div>
    </ConsoleShell>
  );
}

/** Store Console → History: finished holds, grouped by day, and how they ended. */
export function StoreHistory() {
  const me = useStoreMe();
  if (!me) return <Navigate to="/app" replace />;
  return (
    <ConsoleShell>
      <PageHeader
        title="History"
        purpose="Holds that were picked up, refused, cancelled or expired."
        action={<AskAction label="How is my store doing?" question="How is my store doing this week?" />}
      />
      <Card>
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

type StockFilter = 'LOW_STOCK' | 'OUT_OF_STOCK' | 'IN_STOCK' | null;
const STOCK_CHIPS: { id: Exclude<StockFilter, null>; text: string; tone: 'warning' | 'danger' | 'success' }[] = [
  { id: 'LOW_STOCK', text: 'Low stock', tone: 'warning' },
  { id: 'OUT_OF_STOCK', text: 'Out of stock', tone: 'danger' },
  { id: 'IN_STOCK', text: 'In stock', tone: 'success' },
];
const URGENCY: Record<string, number> = { OUT_OF_STOCK: 0, LOW_STOCK: 1 };
// The row accent follows the brand's stock status; the bar is this row's stock against the
// best-stocked row, so short rows stand out.
const STATUS_ROW: Record<string, string> = { LOW_STOCK: 'st-row--warning', OUT_OF_STOCK: 'st-row--danger' };
const availTone = (n: number) => (n <= 0 ? 'danger' : n <= 2 ? 'warning' : 'ok');

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
  const [filter, setFilter] = useState<StockFilter>(null);
  const [query, setQuery] = useState('');
  const items = useMemo(() => stock.data?.items ?? [], [stock.data]);
  const latest = items
    .map((i) => i.last_updated_at)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);
  const mostAvailable = Math.max(1, ...items.map((i) => i.available_quantity));
  const shown = items
    .filter((i) => !filter || i.availability_status === filter)
    .filter((i) => {
      const q = query.trim().toLowerCase();
      return !q || `${i.product_title ?? ''} ${i.variant_title ?? ''} ${i.sku}`.toLowerCase().includes(q);
    })
    .sort(
      (a, b) =>
        (URGENCY[a.availability_status] ?? 2) - (URGENCY[b.availability_status] ?? 2) ||
        a.available_quantity - b.available_quantity,
    );
  if (!me) return <Navigate to="/app" replace />;
  const store = me.store;
  const hours = hoursText(store.store_hours);
  const purpose = latest
    ? `Updated ${ago(latest)} from ${me.brand_name}'s retail file · You can't edit stock here`
    : `${me.brand_name} updates this from its retail file · You can't edit stock here`;
  return (
    <ConsoleShell>
      <PageHeader
        title="Stock"
        purpose={purpose}
        action={
          <Button variant="brand" onClick={stock.reload}>
            Refresh
          </Button>
        }
      />
      {latest && <p className="sr-only">Stock as of {formatDateTime(latest)}</p>}
      <div className="st-stock">
        <Card className="st-stock__main">
          {stock.error && <ErrorState message={stock.error} onRetry={stock.reload} />}
          {!stock.data && !stock.error && <Skeleton lines={4} label="Loading stock" />}
          {items.some((i) => i.stale) && (
            <p className="notice small" role="status">
              Some stock rows are out of date. Customers are told when the stock was last updated; ask your brand to
              import a fresh retail file.
            </p>
          )}
          {stock.data && items.length === 0 && (
            <EmptyState>
              No stock has been imported for this store yet. Your brand imports it from its retail file.
            </EmptyState>
          )}
          {items.length > 0 && (
            <>
              <div className="st-stock__bar">
                <div className="pf-chips" role="group" aria-label="Filter by stock">
                  {STOCK_CHIPS.map((c) => {
                    const count = items.filter((i) => i.availability_status === c.id).length;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={`pf-chip pf-chip--${c.tone === 'danger' ? 'warning' : c.tone}`}
                        aria-pressed={filter === c.id}
                        disabled={count === 0}
                        onClick={() => setFilter((f) => (f === c.id ? null : c.id))}
                      >
                        <span className={`pf-chip__count st-count--${c.tone}`}>{count}</span> {c.text}
                      </button>
                    );
                  })}
                </div>
                <label className="st-search">
                  <Search size={16} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search stock"
                    placeholder="Search product or SKU"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>
              <div className="ui-table-wrap st-stock-table">
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th scope="col">Product</th>
                      <th scope="col" className="is-numeric">
                        Quantity
                      </th>
                      <th scope="col" className="is-numeric">
                        <Tip text="Units held for customers at this store; released when a hold is cancelled or expires.">
                          Reserved
                        </Tip>
                      </th>
                      <th scope="col" className="is-numeric">
                        <Tip text="Quantity − reserved: what a new shopper can hold now.">Available</Tip>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((item) => {
                      const tone = availTone(item.available_quantity);
                      const differs = item.last_updated_at && latest && item.last_updated_at !== latest;
                      return (
                        <tr key={item.sku} className={STATUS_ROW[item.availability_status]}>
                          <td data-label="Product">
                            <span className="cell-product">
                              <ProductThumb
                                src={item.image_url ?? null}
                                name={item.product_title ?? item.sku}
                                size={36}
                              />
                              <span className="st-product">
                                <span>
                                  {item.product_title ?? '—'}
                                  {item.variant_title && <span className="muted"> · {item.variant_title}</span>}
                                </span>
                                <span className="mono small muted">{item.sku}</span>
                                {item.availability_status !== 'IN_STOCK' && (
                                  <span>
                                    <StatusPill status={item.availability_status} />
                                  </span>
                                )}
                                {(differs || item.stale) && (
                                  <span className="small muted">
                                    Stock as of {formatDateTime(item.last_updated_at)}{' '}
                                    {item.stale && <span className="badge stale">stale</span>}
                                  </span>
                                )}
                              </span>
                            </span>
                          </td>
                          <td data-label="Quantity" className="is-numeric">
                            {item.quantity}
                          </td>
                          <td data-label="Reserved" className="is-numeric">
                            {item.reserved_quantity}
                          </td>
                          <td data-label="Available" className="is-numeric">
                            <span className={`st-avail st-avail--${tone}`}>{item.available_quantity}</span>
                            <span className={`st-avail__bar st-avail__bar--${tone}`}>
                              <ProgressBar value={item.available_quantity} max={mostAvailable} />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {shown.length === 0 && <p className="muted small">No stock matches.</p>}
              {autoPoll && <p className="muted small">Refreshes when you press Refresh.</p>}
            </>
          )}
        </Card>
        <Card title="Your store" className="st-store">
          <ul className="st-store__facts">
            <li>
              <MapPin size={16} aria-hidden="true" />
              <span>
                <strong>{store.store_name}</strong>
                <span className="muted small">
                  {store.address ?? 'Address not provided'}
                  {store.city ? `, ${store.city}` : ''}
                </span>
              </span>
            </li>
            <li>
              <StoreIcon size={16} aria-hidden="true" />
              <span>{me.retailer_name}</span>
            </li>
            <li>
              <Tag size={16} aria-hidden="true" />
              <span>{me.brand_name}</span>
            </li>
            <li>
              <span className="st-store__label">Status</span>
              <StatusPill status={store.store_status} />
            </li>
            <li>
              <span className="st-store__label">Hours</span>
              {hours ? (
                store.store_hours?.timezone ? (
                  <Tip text={`Store time: ${store.store_hours.timezone}`}>
                    <span>{hours}</span>
                  </Tip>
                ) : (
                  <span>{hours}</span>
                )
              ) : (
                <span className="muted">not provided</span>
              )}
            </li>
          </ul>
        </Card>
      </div>
    </ConsoleShell>
  );
}
