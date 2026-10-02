import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/apiContext';
import { label as enumLabel } from '../../lib/labels';
import { errorMessage, useLoad } from '../../components/ConsoleShell';

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
}

const ACTION_LABEL: Record<string, string> = {
  CONFIRMED: 'Confirm',
  READY: 'Mark ready',
  CUSTOMER_ARRIVED: 'Customer arrived',
  COMPLETED: 'Complete',
  CANCELLED: 'Refuse',
};
const STATUS_LABEL: Record<string, string> = {
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

const label = (r: QueueReservation) =>
  `${r.quantity} × ${r.product_title ?? r.sku}${r.variant_title ? ` ${r.variant_title}` : ''}`;

/**
 * The store's reservation queue (docs/11 §5, Change 13 F1–F4): the most urgent first
 * (new, then the soonest expiry), the actions allowed now, and after each action a
 * "Next up" line — forward dispatch for store staff. Customers are shown masked only.
 */
export function RetailerQueue({ autoPoll, onChanged }: { autoPoll: boolean; onChanged: () => void }) {
  const api = useApi();
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [refusing, setRefusing] = useState<Record<string, { reason: string; note: string }>>({});
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const list = useLoad(
    useCallback(() => api.get<{ reservations: QueueReservation[] }>(`/api/reservations?view=${tab}`), [api, tab]),
  );
  const { reload } = list;

  // New reservations get a visible "New" cue (local profile polls every 15 s; Refresh works everywhere).
  useEffect(() => {
    if (tab !== 'active' || !list.data) return;
    const ids = list.data.reservations.map((r) => r.reservation_id);
    if (seen.current) {
      const arrived = ids.filter((id) => !seen.current!.has(id));
      if (arrived.length) setFresh((prev) => new Set([...prev, ...arrived]));
    }
    seen.current = new Set([...(seen.current ?? []), ...ids]);
  }, [list.data, tab]);

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
      setNotice(
        `${label(r)}: ${STATUS_LABEL[res.status] ?? res.status}${told}.` +
          (next ? ` Next up: ${label(next)}, ${expiresIn(next.expires_at, Date.now())}.` : ' Nothing else waiting.'),
      );
      setFresh((prev) => {
        const s = new Set(prev);
        s.delete(r.reservation_id);
        return s;
      });
      reload();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const rows = list.data?.reservations ?? [];
  return (
    <div className="queue" aria-label="Reservation queue">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'active'} onClick={() => setTab('active')}>
          Active
        </button>
        <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
          Completed & cancelled
        </button>
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
          {tab === 'active'
            ? 'No reservations waiting. New customer holds appear here automatically.'
            : 'No completed or cancelled reservations yet.'}
        </p>
      )}
      <ul className="queue-list">
        {rows.map((r) => (
          <li key={r.reservation_id} className="queue-card">
            <div>
              <strong>{label(r)}</strong> {fresh.has(r.reservation_id) && <span className="badge new">New</span>}{' '}
              <span className="badge">{STATUS_LABEL[r.status] ?? enumLabel(r.status)}</span>
            </div>
            <div className="small">
              {r.customer_display} · created {storeTime(r.created_at, r.store_timezone)} · held until{' '}
              {storeTime(r.expires_at, r.store_timezone)}
              {tab === 'active' && ` (${expiresIn(r.expires_at, now)})`}
              {r.customer_eta && ` · ETA ${storeTime(r.customer_eta, r.store_timezone)}`}
            </div>
            {r.last_notification && (
              <div
                className={`small ${r.last_notification.status === 'SENT' ? 'muted' : 'warn-text'}`}
                data-testid="notification"
              >
                Last update: {enumLabel(r.last_notification.event).toLowerCase()} —{' '}
                {NOTIFY_LABEL[r.last_notification.status]}
              </div>
            )}
            {r.cancel_reason && (
              <div className="small muted">
                {r.cancelled_by === 'RETAILER' ? 'Refused' : 'Cancelled by the customer'}:{' '}
                {REFUSAL_LABEL[r.cancel_reason] ?? r.cancel_reason.toLowerCase().replace(/_/g, ' ')}
              </div>
            )}
            {r.pickup_code_locked && (
              <div className="small warn-text">Too many wrong pickup codes — this reservation can't be completed.</div>
            )}
            {r.allowed_actions.length > 0 && (
              <div className="queue-actions">
                {r.allowed_actions.includes('COMPLETED') && (
                  <input
                    aria-label={`Pickup code for ${label(r)}`}
                    placeholder="Customer's pickup code"
                    inputMode="numeric"
                    maxLength={6}
                    value={codes[r.reservation_id] ?? ''}
                    onChange={(e) => setCodes({ ...codes, [r.reservation_id]: e.target.value.replace(/\D/g, '') })}
                  />
                )}
                {r.allowed_actions.includes('CANCELLED') && (
                  <>
                    <select
                      aria-label={`Refusal reason for ${label(r)}`}
                      value={refusing[r.reservation_id]?.reason ?? ''}
                      onChange={(e) =>
                        setRefusing({
                          ...refusing,
                          [r.reservation_id]: { note: refusing[r.reservation_id]?.note ?? '', reason: e.target.value },
                        })
                      }
                    >
                      <option value="">Refuse because…</option>
                      {Object.entries(REFUSAL_LABEL).map(([value, text]) => (
                        <option key={value} value={value}>
                          {text}
                        </option>
                      ))}
                    </select>
                    {refusing[r.reservation_id]?.reason === 'OTHER' && (
                      <input
                        aria-label="Internal note (not shown to the customer)"
                        placeholder="Internal note (not shown to the customer)"
                        maxLength={140}
                        value={refusing[r.reservation_id]?.note ?? ''}
                        onChange={(e) =>
                          setRefusing({
                            ...refusing,
                            [r.reservation_id]: { reason: 'OTHER', note: e.target.value },
                          })
                        }
                      />
                    )}
                  </>
                )}
                {r.allowed_actions.map((to) => (
                  <button
                    key={to}
                    type="button"
                    className={to === 'CANCELLED' ? 'secondary' : ''}
                    disabled={
                      busy === r.reservation_id ||
                      (to === 'COMPLETED' && (codes[r.reservation_id] ?? '').length !== 6) ||
                      (to === 'CANCELLED' && !refusing[r.reservation_id]?.reason)
                    }
                    onClick={() => void act(r, to)}
                  >
                    {ACTION_LABEL[to] ?? to}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "This week" for the own store: reservations, completed, refused, expired. */
export function WeekStrip({ storeId, reloadKey }: { storeId: string; reloadKey: number }) {
  const api = useApi();
  const summary = useLoad(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useCallback(
      () =>
        api.get<{ reservations: number; completed: number; refused: number; expired: number }>(
          `/api/retail/stores/${encodeURIComponent(storeId)}/summary`,
        ),
      [api, storeId, reloadKey],
    ),
  );
  if (!summary.data) return null;
  const s = summary.data;
  return (
    <p className="week-strip" aria-label="This week">
      <strong>This week:</strong> {s.reservations} reservations · {s.completed} completed · {s.refused} refused ·{' '}
      {s.expired} expired
    </p>
  );
}
