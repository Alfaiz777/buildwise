import { ChevronDown, ExternalLink, PackageCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  ProductThumb,
  Segmented,
  Skeleton,
  StatusPill,
  Timeline,
  Tip,
  type Tone,
} from '../../components/ui';
import { useHideSynthetic, withoutSynthetic } from '../../lib/synthetic';
import { PageHeader } from '../platform/PlatformChrome';
import { AskScope } from './askQwikspot';
import { REFUSAL_TEXT, type ConversationDetail, type ReservationRow } from './conversationTypes';
import { formatDateTime } from './types';
import { whySentence } from './whySentence';
import './brand.css';
import './reservations.css';

type Filter = 'ALL' | 'ACTIVE' | 'PICKED_UP' | 'REFUSED' | 'EXPIRED';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PICKED_UP', label: 'Picked up' },
  { value: 'REFUSED', label: 'Refused' },
  { value: 'EXPIRED', label: 'Expired' },
];
const FILTER_PARAM: Record<string, Filter> = {
  refused: 'REFUSED',
  active: 'ACTIVE',
  picked_up: 'PICKED_UP',
  expired: 'EXPIRED',
};

const matches = (r: ReservationRow, f: Filter) => {
  switch (f) {
    case 'ALL':
      return true;
    case 'ACTIVE':
      return r.active;
    case 'PICKED_UP':
      return r.status === 'COMPLETED';
    case 'REFUSED':
      return r.status === 'CANCELLED' && r.cancelled_by === 'RETAILER';
    case 'EXPIRED':
      return r.status === 'EXPIRED';
  }
};

/** How the hold ended, in words. */
export function reservationOutcome(r: ReservationRow): string {
  if (r.status === 'COMPLETED') return 'Picked up — in-store purchase';
  if (r.status === 'EXPIRED') return 'Expired — not collected';
  if (r.status === 'CANCELLED') {
    if (r.cancelled_by === 'RETAILER') return `Refused: ${REFUSAL_TEXT[r.cancel_reason ?? ''] ?? 'no reason given'}`;
    if (r.cancelled_by === 'CUSTOMER') return 'Cancelled by the customer';
    return 'Cancelled';
  }
  return 'In progress';
}

/** The board's columns (UI-P3): where each status sits. */
const COLUMNS: { key: string; title: string; statuses: string[] }[] = [
  { key: 'waiting', title: 'Waiting', statuses: ['PENDING'] },
  { key: 'confirmed', title: 'Confirmed', statuses: ['CONFIRMED'] },
  { key: 'ready', title: 'Ready', statuses: ['READY', 'CUSTOMER_ARRIVED'] },
  { key: 'picked', title: 'Picked up', statuses: ['COMPLETED'] },
];
const ENDED = ['CANCELLED', 'EXPIRED'];
/** Cards shown per column before "Show all". */
const PER_COLUMN = 12;
/** Cards in the phone list before "Show more". */
const PAGE = 15;

/** True at phone width: the board becomes one list (one or the other is rendered, never both). */
function useNarrow(): boolean {
  const query = '(max-width: 900px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

const minutesUntil = (iso: string, now: number) => Math.round((Date.parse(iso) - now) / 60_000);

/** "Held for 18 more min" (amber under 10 min, red once expired) for an active hold. */
function countdown(r: ReservationRow, now: number): { text: string; tone: Tone } | null {
  if (!r.active) return null;
  const min = minutesUntil(r.expires_at, now);
  if (min <= 0) return { text: 'Hold expired', tone: 'danger' };
  const text = min >= 60 ? `Held for ${Math.floor(min / 60)} h ${min % 60} min` : `Held for ${min} more min`;
  return { text, tone: min < 10 ? 'warning' : 'neutral' };
}

function DemoPill() {
  return (
    <Tip text="Generated 4-week demo history, not a real shopper">
      <Badge tone="neutral">Demo</Badge>
    </Tip>
  );
}

function HoldCard({ r, now, onOpen }: { r: ReservationRow; now: number; onOpen: (r: ReservationRow) => void }) {
  const c = countdown(r, now);
  const item = `${r.quantity > 1 ? `${r.quantity} × ` : ''}${r.product_title ?? r.sku}${r.variant_title ? ` ${r.variant_title}` : ''}`;
  return (
    <li>
      <button
        type="button"
        className="rv-card"
        aria-label={`${item} at ${r.store_name}, ${r.customer_display}`}
        title="Open the hold: its timeline and why this store"
        onClick={() => onOpen(r)}
      >
        <ProductThumb src={r.image_url ?? null} name={r.product_title ?? r.sku} size={36} />
        <span className="rv-card__body">
          <strong className="rv-card__item">{item}</strong>
          <span className="small">{r.store_name}</span>
          <span className="small muted">{r.customer_display}</span>
          <span className="rv-card__pills">
            {c && <Badge tone={c.tone}>{c.text}</Badge>}
            {!r.active && <span className="small muted">{reservationOutcome(r)}</span>}
            {r.demo_history && <DemoPill />}
          </span>
        </span>
      </button>
    </li>
  );
}

/** One column of the board, with its count. */
function Column({
  title,
  rows,
  now,
  onOpen,
}: {
  title: string;
  rows: ReservationRow[];
  now: number;
  onOpen: (r: ReservationRow) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, PER_COLUMN);
  return (
    <section className="rv-col" aria-label={`${title}: ${rows.length}`}>
      <h2 className="rv-col__title">
        {title} <span className="rv-col__count">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="small muted rv-col__empty">None</p>
      ) : (
        <ul className="rv-col__cards">
          {shown.map((r) => (
            <HoldCard key={r.reservation_id} r={r} now={now} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {rows.length > PER_COLUMN && (
        <button type="button" className="ui-link-button small" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

/** The hold's drawer: its timeline, why this store, and its conversation. */
function HoldDrawer({ r, onClose }: { r: ReservationRow | null; onClose: () => void }) {
  const api = useApi();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  useEffect(() => {
    setDetail(null);
    if (!r?.conversation_id) return;
    let gone = false;
    api
      .get<ConversationDetail>(`/api/brand/conversations/${encodeURIComponent(r.conversation_id)}`)
      .then((d) => !gone && setDetail(d))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [api, r]);
  if (!r) return null;
  const rec = detail?.recommendations.find((x) => x.reservation?.reservation_id === r.reservation_id) ?? null;
  const history = rec?.reservation?.status_history;
  const steps = history?.length
    ? history.map((s) => ({ id: s.status, at: s.at, status: s.status }))
    : [
        { id: 'created', at: r.created_at, status: 'PENDING' },
        ...(r.completed_at ? [{ id: 'done', at: r.completed_at, status: 'COMPLETED' }] : []),
        ...(r.cancelled_at ? [{ id: 'cancel', at: r.cancelled_at, status: 'CANCELLED' }] : []),
        ...(r.status === 'EXPIRED' ? [{ id: 'expired', at: r.expires_at, status: 'EXPIRED' }] : []),
      ];
  const words: Record<string, string> = {
    PENDING: 'Hold placed',
    CONFIRMED: `${r.store_name} confirmed`,
    READY: 'Ready for pickup',
    CUSTOMER_ARRIVED: 'Customer arrived',
    COMPLETED: 'Picked up — in-store purchase',
    CANCELLED: reservationOutcome({ ...r, status: 'CANCELLED' }),
    EXPIRED: 'Expired — not collected',
  };
  const tone: Record<string, 'success' | 'danger' | 'info' | 'neutral' | 'primary'> = {
    PENDING: 'primary',
    COMPLETED: 'success',
    CANCELLED: r.cancelled_by === 'RETAILER' ? 'danger' : 'neutral',
    EXPIRED: 'neutral',
  };
  return (
    <Drawer open title={`${r.product_title ?? r.sku}${r.variant_title ? ` ${r.variant_title}` : ''}`} onClose={onClose}>
      <div className="rv-drawer">
        <p className="rv-drawer__meta">
          <StatusPill status={r.status} /> <span>{r.store_name}</span> · <span>{r.customer_display}</span>
        </p>
        <dl className="rv-drawer__facts small">
          <dt>Placed</dt>
          <dd>{formatDateTime(r.created_at)}</dd>
          <dt>Hold until</dt>
          <dd>{formatDateTime(r.expires_at)}</dd>
          <dt>Outcome</dt>
          <dd>{reservationOutcome(r)}</dd>
        </dl>
        {rec && (
          <div className="rv-drawer__why">
            <h3>Why this store</h3>
            <p>{whySentence(rec)}</p>
          </div>
        )}
        <h3>Timeline</h3>
        <Timeline
          label="Hold timeline"
          items={steps.map((s) => ({
            id: s.id,
            title: words[s.status] ?? s.status,
            time: formatDateTime(s.at),
            tone: tone[s.status] ?? 'info',
          }))}
        />
        {r.conversation_id ? (
          <Link
            className="ui-button ui-button--brand rv-drawer__open"
            to={`/brand/conversations?c=${encodeURIComponent(r.conversation_id)}`}
          >
            Open the conversation <ExternalLink size={14} aria-hidden="true" />
          </Link>
        ) : (
          <p className="small muted">No conversation recorded for this hold (generated demo history).</p>
        )}
      </div>
    </Drawer>
  );
}

/**
 * Brand Console → Reservations (docs/11 §4; UI-3; UI-P3 board): is every hold being handled,
 * and how did each end? A status board on a desktop (Waiting → Confirmed → Ready → Picked up,
 * plus Ended), a filtered list on a phone; a card opens the hold's timeline and its
 * conversation. Customers are masked.
 */
export function ReservationsPage() {
  const api = useApi();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<Filter>(FILTER_PARAM[params.get('filter') ?? ''] ?? 'ALL');
  const [hideSynthetic, setHideSynthetic] = useHideSynthetic();
  const [open, setOpen] = useState<ReservationRow | null>(null);
  const narrow = useNarrow();
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter, hideSynthetic]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const list = useLoad(
    useCallback(() => api.get<{ reservations: ReservationRow[] }>('/api/reservations?limit=200'), [api]),
  );
  const { shown, hidden } = withoutSynthetic(
    (list.data?.reservations ?? []).filter((r) => matches(r, filter)),
    hideSynthetic,
  );
  const visible = useMemo(
    () => withoutSynthetic(list.data?.reservations ?? [], hideSynthetic).shown,
    [list.data, hideSynthetic],
  );
  const active = visible.filter((r) => r.active);
  const waiting = active.filter((r) => r.status === 'PENDING');
  const oldest = waiting.length
    ? Math.max(...waiting.map((r) => Math.round((now - Date.parse(r.created_at)) / 60_000)))
    : 0;
  const expiring = active.filter((r) => {
    const m = minutesUntil(r.expires_at, now);
    return m > 0 && m <= 60;
  });
  const weekAgo = now - 7 * 24 * 3_600_000;
  const pickedWeek = visible.filter(
    (r) => r.status === 'COMPLETED' && Date.parse(r.completed_at ?? r.created_at) >= weekAgo,
  );
  const ended = shown.filter((r) => ENDED.includes(r.status));

  return (
    <ConsoleShell>
      <AskScope days={7} includeHistory={!hideSynthetic} />
      <PageHeader
        title="Reservations"
        purpose="Every hold a shopper placed: is the store on it, and how did it end? Customers are masked."
      />
      <div className="pf-filters">
        <Segmented
          label="History"
          value={hideSynthetic ? 'live' : 'all'}
          options={[
            { value: 'live', label: 'Live only' },
            { value: 'all', label: 'Live + demo history' },
          ]}
          onChange={(v) => setHideSynthetic(v === 'live')}
        />
        {hideSynthetic && hidden > 0 && <span className="muted small">{hidden} synthetic records hidden</span>}
        <Segmented label="Show" value={filter} options={FILTERS} onChange={setFilter} />
      </div>

      {list.data && (
        <section className="rv-strip" aria-label="Holds right now">
          <div className="pf-tile">
            <span className="pf-tile__label">Active</span>
            <span className="pf-tile__value pf-tile__value--sm">{active.length}</span>
            <span className="pf-tile__sub">holds not yet finished</span>
          </div>
          <div className={`pf-tile${waiting.length ? ' rv-tile--warning' : ''}`}>
            <span className="pf-tile__label">Waiting for store</span>
            <span className="pf-tile__value pf-tile__value--sm">{waiting.length}</span>
            <span className="pf-tile__sub">{waiting.length ? `oldest waiting ${oldest} min` : 'none to confirm'}</span>
          </div>
          <div className={`pf-tile${expiring.length ? ' rv-tile--warning' : ''}`}>
            <span className="pf-tile__label">Expiring within 60 min</span>
            <span className="pf-tile__value pf-tile__value--sm">{expiring.length}</span>
            <span className="pf-tile__sub">collect or they lapse</span>
          </div>
          <div className="pf-tile">
            <span className="pf-tile__label">Picked up</span>
            <span className="pf-tile__value pf-tile__value--sm">{pickedWeek.length}</span>
            <span className="pf-tile__sub">in the last 7 days</span>
          </div>
        </section>
      )}

      {list.error && <p className="error">{list.error}</p>}
      {!list.data && !list.error && <Skeleton lines={4} />}
      {list.data && shown.length === 0 && (
        <EmptyState icon={<PackageCheck size={22} />}>
          No reservations here yet. Shoppers place holds from the chat.
        </EmptyState>
      )}
      {list.data && shown.length > 0 && !narrow && (
        <>
          {/* Desktop: the board. */}
          <div className="rv-board" aria-label="Reservations board">
            {COLUMNS.map((c) => (
              <Column
                key={c.key}
                title={c.title}
                rows={shown.filter((r) => c.statuses.includes(r.status))}
                now={now}
                onOpen={setOpen}
              />
            ))}
            <details className="rv-col rv-col--ended" open={filter === 'REFUSED' || filter === 'EXPIRED'}>
              <summary className="rv-col__title">
                Ended <span className="rv-col__count">{ended.length}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <span className="small muted">Refused, expired or cancelled</span>
              <ul className="rv-col__cards">
                {ended.slice(0, 40).map((r) => (
                  <HoldCard key={r.reservation_id} r={r} now={now} onOpen={setOpen} />
                ))}
              </ul>
            </details>
          </div>
        </>
      )}
      {/* Phone: one list for the chosen filter, 15 at a time. */}
      {list.data && shown.length > 0 && narrow && (
        <>
          <ul className="rv-list" aria-label="Reservations">
            {shown.slice(0, limit).map((r) => (
              <HoldCard key={r.reservation_id} r={r} now={now} onOpen={setOpen} />
            ))}
          </ul>
          {shown.length > limit && (
            <div className="rv-more">
              <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>
                Show {Math.min(PAGE, shown.length - limit)} more
              </Button>
              <span className="small muted">
                Showing {limit} of {shown.length}
              </span>
            </div>
          )}
        </>
      )}
      <HoldDrawer r={open} onClose={() => setOpen(null)} />
    </ConsoleShell>
  );
}
