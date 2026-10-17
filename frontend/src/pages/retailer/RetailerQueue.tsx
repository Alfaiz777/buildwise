import { CheckCircle2, ChevronDown, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApi } from '../../api/apiContext';
import { errorMessage, useLoad } from '../../components/ConsoleShell';
import { Badge, Button, ConfirmDialog, Menu, ProductThumb, Segmented, Tip, useToast } from '../../components/ui';
import { label as enumLabel } from '../../lib/labels';
import { formatDateTime } from '../brand/types';
import './store.css';

export interface QueueReservation {
  reservation_id: string;
  store_name: string;
  store_timezone: string;
  product_title: string | null;
  variant_title: string | null;
  sku: string;
  quantity: number;
  status: string;
  allowed_actions: string[];
  pickup_code_locked: boolean;
  customer_display: string;
  customer_eta: string | null;
  created_at: string;
  expires_at: string;
  /** When it ended (history): picked up, or refused / cancelled. */
  completed_at?: string | null;
  cancelled_at?: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  last_notification: { status: string; event: string; message_kind: string | null; at: string } | null;
  /** UI-4: why the hold came to this store (store names and this store's distance only). */
  why_here?: {
    text: string;
    distance_km: number | null;
    closer_unavailable: { store_name: string; reason: string }[];
    options: number;
  } | null;
  image_url?: string | null;
  demo_history?: boolean;
}

export const ACTION_LABEL: Record<string, string> = {
  CONFIRMED: 'Confirm',
  READY: 'Mark ready',
  CUSTOMER_ARRIVED: 'Customer arrived',
  COMPLETED: 'Complete',
  CANCELLED: 'Refuse',
};
export const STATUS_LABEL: Record<string, string> = {
  PENDING: 'New — needs confirming',
  CONFIRMED: 'Confirmed',
  READY: 'Ready for pickup',
  CUSTOMER_ARRIVED: 'Customer here',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};
export const REFUSAL_LABEL: Record<string, string> = {
  NOT_ACTUALLY_IN_STOCK: 'Not actually in stock',
  DAMAGED: 'Damaged',
  STORE_CLOSING_EARLY: 'Store closing early',
  OTHER: 'Other',
};
const NOTIFY_LABEL: Record<string, string> = {
  SENT: 'customer notified',
  NOT_SENT_OPTED_OUT: 'customer opted out; not notified',
  NOT_SENT_NO_CONVERSATION: 'no conversation; not notified',
  NOT_SENT_OUTSIDE_WINDOW: 'no thank-you (last message over 24 h ago)',
};

/** "12:40" in the store's timezone. */
export function storeTime(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** "expires in 40 min" / "expired". */
export function expiresIn(iso: string, now: number): string {
  const min = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (min <= 0) return 'expiring now';
  return min >= 60 ? `expires in ${Math.floor(min / 60)} h ${min % 60} min` : `expires in ${min} min`;
}

/** UI-P2: the countdown pill — "Held for 18 more min", amber under 10 min, red when expired. */
export function holdCountdown(iso: string, now: number): { text: string; tone: 'neutral' | 'warning' | 'danger' } {
  const min = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (min <= 0) return { text: 'Hold expired', tone: 'danger' };
  const text = min >= 60 ? `Held for ${Math.floor(min / 60)} h ${min % 60} more min` : `Held for ${min} more min`;
  return { text, tone: min < 10 ? 'warning' : 'neutral' };
}

export const itemLabel = (r: Pick<QueueReservation, 'quantity' | 'product_title' | 'sku' | 'variant_title'>) =>
  `${r.quantity} × ${r.product_title ?? r.sku}${r.variant_title ? ` ${r.variant_title}` : ''}`;

/** How a finished hold ended, in words. */
export function endedText(r: QueueReservation): string {
  if (r.status === 'COMPLETED') return 'Picked up — in-store purchase';
  if (r.status === 'EXPIRED') return 'Expired — not collected';
  if (r.status === 'CANCELLED') {
    return r.cancelled_by === 'RETAILER'
      ? `Refused: ${REFUSAL_LABEL[r.cancel_reason ?? ''] ?? 'other'}`
      : 'Cancelled by the customer';
  }
  return STATUS_LABEL[r.status] ?? enumLabel(r.status);
}

/** UI-P2: a finished hold's outcome as a coloured pill. */
function outcomePill(r: QueueReservation): { text: string; tone: 'success' | 'danger' | 'neutral' } {
  if (r.status === 'COMPLETED') return { text: 'Picked up', tone: 'success' };
  if (r.status === 'CANCELLED' && r.cancelled_by === 'RETAILER')
    return { text: `Refused · ${REFUSAL_LABEL[r.cancel_reason ?? ''] ?? 'Other'}`, tone: 'danger' };
  if (r.status === 'CANCELLED') return { text: 'Cancelled by the customer', tone: 'neutral' };
  if (r.status === 'EXPIRED') return { text: 'Expired', tone: 'neutral' };
  return { text: STATUS_LABEL[r.status] ?? enumLabel(r.status), tone: 'neutral' };
}

/** What a Refresh press found, for its toast. */
function refreshedText(view: 'active' | 'history', n: number): string {
  if (view === 'history') return `History refreshed — ${n === 1 ? '1 hold' : `${n} holds`}.`;
  return n === 0 ? 'Holds refreshed — nothing waiting.' : `Holds refreshed — ${n} waiting.`;
}

/** "14:05" in this browser's time (when the list was last loaded). */
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The next step a store takes on a hold (never "Refuse"). */
export const primaryAction = (r: QueueReservation) => r.allowed_actions.find((a) => a !== 'CANCELLED') ?? null;

export type HistoryFilter = 'ALL' | 'PICKED_UP' | 'REFUSED' | 'EXPIRED';
const HISTORY_FILTERS: { value: HistoryFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PICKED_UP', label: 'Picked up' },
  { value: 'REFUSED', label: 'Refused' },
  { value: 'EXPIRED', label: 'Expired' },
];
const historyMatch = (r: QueueReservation, f: HistoryFilter) =>
  f === 'ALL' ||
  (f === 'PICKED_UP' && r.status === 'COMPLETED') ||
  (f === 'REFUSED' && r.status === 'CANCELLED' && r.cancelled_by === 'RETAILER') ||
  (f === 'EXPIRED' && r.status === 'EXPIRED');

/** "Today", "Yesterday", "Mon 13 Oct" — a day in the store's timezone. */
export function dayLabel(iso: string, timezone: string, now = Date.now()): string {
  const day = (t: number) => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(t);
    } catch {
      return new Date(t).toISOString().slice(0, 10);
    }
  };
  const d = day(Date.parse(iso));
  if (d === day(now)) return 'Today';
  if (d === day(now - 86_400_000)) return 'Yesterday';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(iso));
  } catch {
    return d;
  }
}

/** "updated 12 s ago" for the live indicator. */
const secondsAgo = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

/**
 * The store's reservations (docs/11 §5; Change 13 F1–F4; Change 16 UI-4; UI-P2 layout).
 * Active view: the holds hero — a big "Next up" card for the most urgent hold (new first, then
 * the soonest expiry) with its one primary action, then "Also waiting" rows; refusing is in each
 * hold's "⋯" menu and asks for a reason in a dialog. History view: finished holds grouped by day
 * with how they ended. Customers are masked; each hold says why it came to this store.
 */
export function RetailerQueue({
  view,
  autoPoll,
  brandName,
  onChanged,
  onNewHolds,
  tools,
  empty,
}: {
  view: 'active' | 'history';
  autoPoll: boolean;
  brandName: string;
  onChanged?: () => void;
  onNewHolds?: (arrived: QueueReservation[]) => void;
  /** The hero header's own controls (Today: the sound switch). */
  tools?: ReactNode;
  /** What "nothing waiting" adds (Today: the time of the last hold). */
  empty?: ReactNode;
}) {
  const api = useApi();
  const toast = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [refusing, setRefusing] = useState<QueueReservation | null>(null);
  const [refusal, setRefusal] = useState({ reason: '', note: '' });
  const [filter, setFilter] = useState<HistoryFilter>('ALL');
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // A Refresh press (not the first load or the 15 s poll): spin, dim the list, then say so.
  const [refreshing, setRefreshing] = useState(false);
  const pressedAt = useRef<number | null>(null);

  const list = useLoad(
    useCallback(() => api.get<{ reservations: QueueReservation[] }>(`/api/reservations?view=${view}`), [api, view]),
  );
  const { reload } = list;

  // New holds: a "New" badge and a slide-in on the card, and the page is told (toast, title, sound).
  useEffect(() => {
    if (!list.data) return;
    setUpdatedAt(Date.now());
    const rows = list.data.reservations;
    let arrived: QueueReservation[] = [];
    if (view === 'active') {
      if (seen.current) {
        arrived = rows.filter((r) => !seen.current!.has(r.reservation_id));
        if (arrived.length) {
          setFresh((prev) => new Set([...prev, ...arrived.map((r) => r.reservation_id)]));
          onNewHolds?.(arrived);
        }
      }
      seen.current = new Set([...(seen.current ?? []), ...rows.map((r) => r.reservation_id)]);
    }
    if (pressedAt.current !== null) {
      // Spin for at least half a second, so a fast answer is still seen to happen.
      const wait = Math.max(0, 500 - (Date.now() - pressedAt.current));
      pressedAt.current = null;
      setTimeout(() => setRefreshing(false), wait);
      if (!arrived.length) toast.show(refreshedText(view, rows.length)); // a new hold has its own toast
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, view]);

  useEffect(() => {
    if (!autoPoll) return;
    const id = setInterval(() => {
      setNow(Date.now());
      reload();
    }, 15_000);
    return () => clearInterval(id);
  }, [autoPoll, reload]);

  // The countdowns and "updated … ago" stay current between loads (display only).
  useEffect(() => {
    if (view !== 'active') return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [view]);

  // A failed refresh stops the spinner; the error shows above the list.
  useEffect(() => {
    if (!list.error || pressedAt.current === null) return;
    pressedAt.current = null;
    setRefreshing(false);
  }, [list.error]);

  const refresh = () => {
    if (refreshing) return;
    setNow(Date.now());
    pressedAt.current = Date.now();
    setRefreshing(true);
    reload();
  };

  async function act(r: QueueReservation, to: string, why?: { reason: string; note: string }) {
    setBusy(r.reservation_id);
    setError(null);
    try {
      const body: Record<string, string> = { status: to, expected_current_status: r.status };
      if (to === 'COMPLETED') body.pickup_code = (codes[r.reservation_id] ?? '').trim();
      if (to === 'CANCELLED' && why) {
        body.cancel_reason = why.reason;
        if (why.reason === 'OTHER' && why.note.trim()) body.cancel_note = why.note.trim();
      }
      const res = await api.patch<QueueReservation & { notification: { status: string } | null }>(
        `/api/reservations/${r.reservation_id}`,
        body,
      );
      const told = res.notification ? ` (${NOTIFY_LABEL[res.notification.status] ?? res.notification.status})` : '';
      const remaining = await api.get<{ reservations: QueueReservation[] }>('/api/reservations?view=active');
      const next = remaining.reservations[0];
      const done = `${itemLabel(r)}: ${STATUS_LABEL[res.status] ?? res.status}${told}.`;
      setNotice(
        done +
          (next
            ? ` Next up: ${itemLabel(next)}, ${expiresIn(next.expires_at, Date.now())}.`
            : ' Nothing else waiting.'),
      );
      toast.show(done);
      setFresh((prev) => {
        const s = new Set(prev);
        s.delete(r.reservation_id);
        return s;
      });
      setRefusing(null);
      reload();
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const all = list.data?.reservations ?? [];
  const rows = view === 'history' ? all.filter((r) => historyMatch(r, filter)) : all;
  const [nextUp, ...rest] = view === 'active' ? rows : [];
  const holdProps = (r: QueueReservation) => ({
    r,
    now,
    brandName,
    fresh: fresh.has(r.reservation_id),
    busy: busy === r.reservation_id,
    code: codes[r.reservation_id] ?? '',
    onCode: (v: string) => setCodes({ ...codes, [r.reservation_id]: v }),
    onAct: (to: string) => void act(r, to),
    onRefuse: () => {
      setRefusal({ reason: '', note: '' });
      setRefusing(r);
    },
  });

  const refreshButton = (
    <button
      type="button"
      className="ui-icon-button st-refresh"
      aria-label="Refresh"
      title={refreshing ? 'Refreshing…' : 'Refresh'}
      aria-busy={refreshing}
      onClick={refresh}
    >
      <RefreshCw size={16} aria-hidden="true" className={refreshing ? 'ui-spin' : undefined} />
    </button>
  );

  return (
    <div
      className={`queue${refreshing ? ' is-refreshing' : ''}`}
      aria-label={view === 'active' ? 'Reservation queue' : 'Reservation history'}
      aria-busy={refreshing}
    >
      {view === 'active' ? (
        <div className="st-hero__head">
          <h2 className="st-hero__title">Holds</h2>
          <div className="st-hero__tools">
            {tools}
            <span className="st-live" role="status">
              {autoPoll && <span className="st-live__dot" aria-hidden="true" />}
              {autoPoll ? 'Live' : 'Updated'}
              {updatedAt !== null && (
                <span className="muted">
                  {' '}
                  · {autoPoll ? 'updated ' : ''}
                  {secondsAgo(updatedAt, now)}
                </span>
              )}
            </span>
            {refreshButton}
          </div>
        </div>
      ) : (
        <div className="st-history__head">
          <Segmented label="Show" value={filter} options={HISTORY_FILTERS} onChange={setFilter} />
          <div className="st-hero__tools">
            {updatedAt !== null && (
              <span className="small muted" role="status">
                {refreshing ? 'Refreshing…' : `Updated ${clock(updatedAt)}`}
              </span>
            )}
            {refreshButton}
          </div>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {list.error && <p className="error">{list.error}</p>}

      {view === 'active' && list.data && rows.length === 0 && (
        <div className="st-caught-up">
          <CheckCircle2 size={28} aria-hidden="true" />
          <div>
            <strong>You're all caught up.</strong>
            <p className="muted small">
              {autoPoll
                ? `New holds from ${brandName}'s WhatsApp appear here automatically.`
                : `New holds from ${brandName}'s WhatsApp appear here — tap refresh to check.`}
            </p>
            {empty}
          </div>
        </div>
      )}
      {nextUp && (
        <section className="next-up" aria-label="Next up">
          <h3 className="next-up__title">Next up</h3>
          <HoldCard {...holdProps(nextUp)} big />
        </section>
      )}
      {view === 'active' && rest.length > 0 && (
        <>
          <h3 className="queue-title">Also waiting ({rest.length})</h3>
          <ul className="queue-list">
            {rest.map((r) => (
              <li key={r.reservation_id}>
                <HoldCard {...holdProps(r)} />
              </li>
            ))}
          </ul>
        </>
      )}

      {view === 'history' && list.data && rows.length === 0 && (
        <p className="muted">No completed or cancelled reservations here yet.</p>
      )}
      {view === 'history' && rows.length > 0 && (
        <HistoryList key={filter} rows={rows} brandName={brandName} now={now} />
      )}

      <ConfirmDialog
        open={refusing !== null}
        title={refusing ? `Refuse ${itemLabel(refusing)}?` : 'Refuse'}
        confirmLabel="Refuse hold"
        tone="danger"
        busy={refusing !== null && busy === refusing.reservation_id}
        confirmDisabled={!refusal.reason}
        onConfirm={() => refusing && void act(refusing, 'CANCELLED', refusal)}
        onCancel={() => setRefusing(null)}
      >
        <p>The customer is told the store can't hold it, and the stock is released.</p>
        {refusing && (
          <div className="st-refuse">
            <label>
              Why are you refusing?
              <select
                aria-label={`Refusal reason for ${itemLabel(refusing)}`}
                value={refusal.reason}
                onChange={(e) => setRefusal({ ...refusal, reason: e.target.value })}
              >
                <option value="">Choose a reason…</option>
                {Object.entries(REFUSAL_LABEL).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            {refusal.reason === 'OTHER' && (
              <label>
                Internal note
                <input
                  aria-label="Internal note (not shown to the customer)"
                  placeholder="Not shown to the customer"
                  maxLength={140}
                  value={refusal.note}
                  onChange={(e) => setRefusal({ ...refusal, note: e.target.value })}
                />
              </label>
            )}
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** One waiting hold: the big "Next up" card, or a compact "Also waiting" row. */
function HoldCard(props: {
  r: QueueReservation;
  big?: boolean;
  now: number;
  brandName: string;
  fresh: boolean;
  busy: boolean;
  code: string;
  onCode: (v: string) => void;
  onAct: (to: string) => void;
  onRefuse: () => void;
}) {
  const { r, big = false, now } = props;
  const primary = primaryAction(r);
  const why = r.why_here?.text ?? `A customer of ${props.brandName} reserved this through WhatsApp.`;
  const countdown = holdCountdown(r.expires_at, now);
  const others = r.allowed_actions.filter((a) => a !== 'CANCELLED' && a !== primary);
  const needsCode = primary === 'COMPLETED';
  return (
    <article
      className={`queue-card st-hold ${big ? 'queue-card--next st-hold--big' : ''} ${props.fresh ? 'st-hold--fresh' : ''}`}
      aria-label={itemLabel(r)}
    >
      <div className="st-hold__main">
        <ProductThumb src={r.image_url ?? null} name={r.product_title ?? r.sku} size={big ? 72 : 44} />
        <div className="st-hold__body">
          <div className="st-hold__title">
            <strong className="queue-card__item">{itemLabel(r)}</strong>
            {props.fresh && <span className="badge new">New</span>}
          </div>
          <div className="st-hold__meta small">
            <Badge tone={countdown.tone}>{countdown.text}</Badge>
            <span className="muted">{STATUS_LABEL[r.status] ?? enumLabel(r.status)}</span>
            <span>{r.customer_display}</span>
            <span className="muted">
              created {storeTime(r.created_at, r.store_timezone)} · held until{' '}
              {storeTime(r.expires_at, r.store_timezone)}
              {r.customer_eta && ` · ETA ${storeTime(r.customer_eta, r.store_timezone)}`}
            </span>
          </div>
          <p className="why-here st-hold__why small muted">Why this came to you: {why}</p>
          {r.last_notification && (
            <div
              className={`small ${r.last_notification.status === 'SENT' ? 'muted' : 'warn-text'}`}
              data-testid="notification"
            >
              Last update: {enumLabel(r.last_notification.event).toLowerCase()} —{' '}
              {NOTIFY_LABEL[r.last_notification.status]}
            </div>
          )}
          {r.pickup_code_locked && (
            <div className="small warn-text">Too many wrong pickup codes — this reservation can't be completed.</div>
          )}
        </div>
        {r.allowed_actions.includes('CANCELLED') && (
          <Menu
            label={`More actions for ${itemLabel(r)}`}
            items={[{ label: 'Refuse…', onSelect: props.onRefuse, tone: 'danger' }]}
          />
        )}
      </div>
      {r.allowed_actions.some((a) => a !== 'CANCELLED') && (
        <div className="queue-actions st-hold__actions">
          {needsCode && (
            <label className="pickup-code">
              <input
                aria-label={`Pickup code for ${itemLabel(r)}`}
                placeholder="6-digit pickup code"
                inputMode="numeric"
                maxLength={6}
                value={props.code}
                onChange={(e) => props.onCode(e.target.value.replace(/\D/g, ''))}
              />
              <span className="muted small">Ask for the 6-digit code in their WhatsApp.</span>
            </label>
          )}
          {primary && (
            <Button
              variant="brand"
              className={big ? 'ui-button--lg next-up__action st-primary' : 'st-primary'}
              disabled={props.busy || (primary === 'COMPLETED' && props.code.length !== 6)}
              onClick={() => props.onAct(primary)}
            >
              {ACTION_LABEL[primary] ?? primary}
            </Button>
          )}
          {others.map((to) => (
            <Button
              key={to}
              variant="secondary"
              className="st-secondary"
              disabled={props.busy || (to === 'COMPLETED' && props.code.length !== 6)}
              onClick={() => props.onAct(to)}
            >
              {ACTION_LABEL[to] ?? to}
            </Button>
          ))}
        </div>
      )}
    </article>
  );
}

/** History grouped by day (store time): one row per hold, "why" folded into the row. */
/** How many history rows show at first, and how many more each "Show more" adds. */
const HISTORY_PAGE = 15;

function HistoryList({ rows, brandName, now }: { rows: QueueReservation[]; brandName: string; now: number }) {
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const sorted = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const hidden = Math.max(0, sorted.length - limit);
  const groups: { day: string; rows: QueueReservation[] }[] = [];
  for (const r of sorted.slice(0, limit)) {
    const day = dayLabel(r.created_at, r.store_timezone, now);
    const g = groups.at(-1);
    if (g && g.day === day) g.rows.push(r);
    else groups.push({ day, rows: [r] });
  }
  return (
    <div className="st-history">
      {groups.map((g) => (
        <section key={g.day} className="st-history__day" aria-label={g.day}>
          <h3 className="st-history__date">{g.day}</h3>
          <ul className="st-history__list">
            {g.rows.map((r) => {
              const pill = outcomePill(r);
              const ended = r.completed_at ?? r.cancelled_at ?? r.expires_at;
              return (
                <li key={r.reservation_id}>
                  <details className="st-row">
                    <summary aria-label={`${itemLabel(r)} — ${pill.text}`}>
                      <ProductThumb src={r.image_url ?? null} name={r.product_title ?? r.sku} size={28} />
                      <span className="st-row__item">
                        <strong>{itemLabel(r)}</strong>
                        <span className="muted small">{r.customer_display}</span>
                      </span>
                      <Tip text={`${formatDateTime(r.created_at)} → ${formatDateTime(ended)}`}>
                        <span className="st-row__times small muted">
                          {storeTime(r.created_at, r.store_timezone)} → {storeTime(ended, r.store_timezone)}
                        </span>
                      </Tip>
                      <span className="st-row__pills">
                        <Badge tone={pill.tone}>{pill.text}</Badge>
                        {r.demo_history && (
                          <Tip text="Generated demo history, not a real customer">
                            <Badge tone="neutral">Demo</Badge>
                          </Tip>
                        )}
                      </span>
                      <ChevronDown size={16} aria-hidden="true" className="st-row__chevron" />
                    </summary>
                    <div className="st-row__detail small">
                      <p className="muted">{endedText(r)}.</p>
                      <p>
                        <strong>Why this hold came to you:</strong>{' '}
                        {r.why_here?.text ?? `A customer of ${brandName} reserved this through WhatsApp.`}
                      </p>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {hidden > 0 && (
        <div className="st-history__more">
          <Button variant="secondary" onClick={() => setLimit((n) => n + HISTORY_PAGE)}>
            Show {Math.min(hidden, HISTORY_PAGE)} more
          </Button>
          <span className="small muted">
            Showing {limit} of {sorted.length}
          </span>
        </div>
      )}
    </div>
  );
}
