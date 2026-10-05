import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/apiContext';
import { errorMessage, useLoad } from '../../components/ConsoleShell';
import { ProductThumb, useToast } from '../../components/ui';
import { label as enumLabel } from '../../lib/labels';

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

/** The next step a store takes on a hold (never "Refuse"). */
export const primaryAction = (r: QueueReservation) => r.allowed_actions.find((a) => a !== 'CANCELLED') ?? null;

export type HistoryFilter = 'ALL' | 'PICKED_UP' | 'REFUSED' | 'EXPIRED';
const HISTORY_FILTERS: [HistoryFilter, string][] = [
  ['ALL', 'All'],
  ['PICKED_UP', 'Picked up'],
  ['REFUSED', 'Refused'],
  ['EXPIRED', 'Expired'],
];
const historyMatch = (r: QueueReservation, f: HistoryFilter) =>
  f === 'ALL' ||
  (f === 'PICKED_UP' && r.status === 'COMPLETED') ||
  (f === 'REFUSED' && r.status === 'CANCELLED' && r.cancelled_by === 'RETAILER') ||
  (f === 'EXPIRED' && r.status === 'EXPIRED');

/**
 * The store's reservations (docs/11 §5; Change 13 F1–F4; Change 16 UI-4). Active view:
 * a "Next up" card for the most urgent hold (new first, then the soonest expiry) with one
 * big action, then the rest of the queue; after each action a "Next up" notice. History
 * view: finished holds with how they ended. Customers are masked; each card says why the
 * hold came to this store (store names and distance only).
 */
export function RetailerQueue({
  view,
  autoPoll,
  brandName,
  onChanged,
  onNewHolds,
}: {
  view: 'active' | 'history';
  autoPoll: boolean;
  brandName: string;
  onChanged?: () => void;
  onNewHolds?: (arrived: QueueReservation[]) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [refusing, setRefusing] = useState<Record<string, { reason: string; note: string }>>({});
  const [filter, setFilter] = useState<HistoryFilter>('ALL');
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const list = useLoad(
    useCallback(() => api.get<{ reservations: QueueReservation[] }>(`/api/reservations?view=${view}`), [api, view]),
  );
  const { reload } = list;

  // New holds: a "New" badge on the card, and the page is told (toast, title, sound).
  useEffect(() => {
    if (view !== 'active' || !list.data) return;
    const rows = list.data.reservations;
    if (seen.current) {
      const arrived = rows.filter((r) => !seen.current!.has(r.reservation_id));
      if (arrived.length) {
        setFresh((prev) => new Set([...prev, ...arrived.map((r) => r.reservation_id)]));
        onNewHolds?.(arrived);
      }
    }
    seen.current = new Set([...(seen.current ?? []), ...rows.map((r) => r.reservation_id)]);
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

  async function act(r: QueueReservation, to: string) {
    setBusy(r.reservation_id);
    setError(null);
    try {
      const body: Record<string, string> = { status: to, expected_current_status: r.status };
      if (to === 'COMPLETED') body.pickup_code = (codes[r.reservation_id] ?? '').trim();
      if (to === 'CANCELLED') {
        const refusal = refusing[r.reservation_id] ?? { reason: '', note: '' };
        body.cancel_reason = refusal.reason;
        if (refusal.reason === 'OTHER' && refusal.note.trim()) body.cancel_note = refusal.note.trim();
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
  const card = (r: QueueReservation, big = false) => (
    <QueueCard
      key={r.reservation_id}
      r={r}
      big={big}
      view={view}
      now={now}
      brandName={brandName}
      fresh={fresh.has(r.reservation_id)}
      busy={busy === r.reservation_id}
      code={codes[r.reservation_id] ?? ''}
      onCode={(v) => setCodes({ ...codes, [r.reservation_id]: v })}
      refusal={refusing[r.reservation_id]}
      onRefusal={(v) => setRefusing({ ...refusing, [r.reservation_id]: v })}
      onAct={(to) => void act(r, to)}
    />
  );

  return (
    <div className="queue" aria-label={view === 'active' ? 'Reservation queue' : 'Reservation history'}>
      <div className="queue-toolbar">
        {view === 'history' && (
          <div className="filters" role="group" aria-label="Show">
            {HISTORY_FILTERS.map(([value, text]) => (
              <button
                key={value}
                type="button"
                className={filter === value ? '' : 'secondary'}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {text}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setNow(Date.now());
            reload();
          }}
        >
          Refresh
        </button>
      </div>
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
      {list.data && rows.length === 0 && (
        <p className="muted">
          {view === 'active'
            ? `Nothing waiting. New holds from ${brandName}'s WhatsApp appear here.`
            : 'No completed or cancelled reservations here yet.'}
        </p>
      )}
      {nextUp && (
        <section className="next-up" aria-label="Next up">
          <h2 className="next-up__title">Next up</h2>
          {card(nextUp, true)}
        </section>
      )}
      {view === 'active' && rest.length > 0 && <h2 className="queue-title">Also waiting ({rest.length})</h2>}
      <ul className="queue-list">
        {(view === 'active' ? rest : rows).map((r) => (
          <li key={r.reservation_id}>{card(r)}</li>
        ))}
      </ul>
    </div>
  );
}

function QueueCard(props: {
  r: QueueReservation;
  big: boolean;
  view: 'active' | 'history';
  now: number;
  brandName: string;
  fresh: boolean;
  busy: boolean;
  code: string;
  onCode: (v: string) => void;
  refusal: { reason: string; note: string } | undefined;
  onRefusal: (v: { reason: string; note: string }) => void;
  onAct: (to: string) => void;
}) {
  const { r, big, view, now } = props;
  const primary = primaryAction(r);
  const why = r.why_here?.text ?? `A customer of ${props.brandName} reserved this through WhatsApp.`;
  return (
    <article className={`queue-card ${big ? 'queue-card--next' : ''}`} aria-label={itemLabel(r)}>
      <div className="queue-card__head">
        <ProductThumb src={r.image_url ?? null} name={r.product_title ?? r.sku} size={big ? 64 : 44} />
        <div>
          <strong className="queue-card__item">{itemLabel(r)}</strong>{' '}
          {props.fresh && <span className="badge new">New</span>}{' '}
          <span className="badge">
            {view === 'history' ? endedText(r) : (STATUS_LABEL[r.status] ?? enumLabel(r.status))}
          </span>
          {r.demo_history && (
            <span className="badge" title="Generated demo history, not a real customer">
              Synthetic
            </span>
          )}
          <div className="small">
            {r.customer_display} · created {storeTime(r.created_at, r.store_timezone)} · held until{' '}
            {storeTime(r.expires_at, r.store_timezone)}
            {view === 'active' && <strong> ({expiresIn(r.expires_at, now)})</strong>}
            {r.customer_eta && ` · ETA ${storeTime(r.customer_eta, r.store_timezone)}`}
          </div>
        </div>
      </div>
      <p className="why-here small">
        <strong>Why this hold came to you:</strong> {why}
      </p>
      {r.last_notification && (
        <div
          className={`small ${r.last_notification.status === 'SENT' ? 'muted' : 'warn-text'}`}
          data-testid="notification"
        >
          Last update: {enumLabel(r.last_notification.event).toLowerCase()} — {NOTIFY_LABEL[r.last_notification.status]}
        </div>
      )}
      {view === 'active' && r.pickup_code_locked && (
        <div className="small warn-text">Too many wrong pickup codes — this reservation can't be completed.</div>
      )}
      {view === 'active' && r.allowed_actions.length > 0 && (
        <div className="queue-actions">
          {r.allowed_actions.includes('COMPLETED') && (
            <label className="pickup-code">
              <input
                aria-label={`Pickup code for ${itemLabel(r)}`}
                placeholder="Customer's pickup code"
                inputMode="numeric"
                maxLength={6}
                value={props.code}
                onChange={(e) => props.onCode(e.target.value.replace(/\D/g, ''))}
              />
              <span className="muted small">Ask for the 6-digit code in their WhatsApp.</span>
            </label>
          )}
          {r.allowed_actions
            .filter((to) => to !== 'CANCELLED')
            .map((to) => (
              <button
                key={to}
                type="button"
                className={big && to === primary ? 'ui-button--lg next-up__action' : ''}
                disabled={props.busy || (to === 'COMPLETED' && props.code.length !== 6)}
                onClick={() => props.onAct(to)}
              >
                {ACTION_LABEL[to] ?? to}
              </button>
            ))}
          {r.allowed_actions.includes('CANCELLED') && (
            <div className="refuse">
              <select
                aria-label={`Refusal reason for ${itemLabel(r)}`}
                value={props.refusal?.reason ?? ''}
                onChange={(e) => props.onRefusal({ note: props.refusal?.note ?? '', reason: e.target.value })}
              >
                <option value="">Refuse because…</option>
                {Object.entries(REFUSAL_LABEL).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
              {props.refusal?.reason === 'OTHER' && (
                <input
                  aria-label="Internal note (not shown to the customer)"
                  placeholder="Internal note (not shown to the customer)"
                  maxLength={140}
                  value={props.refusal?.note ?? ''}
                  onChange={(e) => props.onRefusal({ reason: 'OTHER', note: e.target.value })}
                />
              )}
              <button
                type="button"
                className="secondary"
                disabled={props.busy || !props.refusal?.reason}
                onClick={() => props.onAct('CANCELLED')}
              >
                Refuse
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
