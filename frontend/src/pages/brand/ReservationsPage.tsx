import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { Card, EmptyState, ProductThumb, Skeleton, StatusPill, Table, type Column } from '../../components/ui';
import { useHideSynthetic, withoutSynthetic } from '../../lib/synthetic';
import { HideSyntheticToggle, SyntheticPill } from './ConversationsPage';
import { REFUSAL_TEXT, type ReservationRow } from './conversationTypes';
import { formatDateTime } from './types';

type Filter = 'ALL' | 'ACTIVE' | 'PICKED_UP' | 'REFUSED' | 'EXPIRED';
const FILTERS: [Filter, string][] = [
  ['ALL', 'All'],
  ['ACTIVE', 'Active'],
  ['PICKED_UP', 'Picked up'],
  ['REFUSED', 'Refused'],
  ['EXPIRED', 'Expired'],
];

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

/**
 * Brand Console → Reservations (docs/11 §4; Change 16, UI-3): every hold with its product,
 * store, status and how it ended; customers masked. A row opens its conversation.
 */
export function ReservationsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<Filter>(params.get('filter') === 'refused' ? 'REFUSED' : 'ALL');
  const [hideSynthetic, setHideSynthetic] = useHideSynthetic();
  const list = useLoad(
    useCallback(() => api.get<{ reservations: ReservationRow[] }>('/api/reservations?limit=200'), [api]),
  );
  const { shown, hidden } = withoutSynthetic(
    (list.data?.reservations ?? []).filter((r) => matches(r, filter)),
    hideSynthetic,
  );

  const columns: Column<ReservationRow>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (r) => (
        <span className="cell-product">
          <ProductThumb src={r.image_url ?? null} name={r.product_title ?? r.sku} size={36} />
          <span>
            {r.product_title ?? r.sku}
            {r.variant_title && <span className="muted small"> · {r.variant_title}</span>}
            {r.quantity > 1 && ` × ${r.quantity}`}
          </span>
        </span>
      ),
    },
    { key: 'store', header: 'Store', render: (r) => r.store_name },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    { key: 'customer', header: 'Customer', render: (r) => <span className="small">{r.customer_display}</span> },
    { key: 'created', header: 'Created', render: (r) => <span className="small">{formatDateTime(r.created_at)}</span> },
    {
      key: 'expires',
      header: 'Hold until',
      render: (r) => <span className="small">{formatDateTime(r.expires_at)}</span>,
    },
    {
      key: 'outcome',
      header: 'Outcome',
      render: (r) => (
        <span className="small">
          {reservationOutcome(r)} {r.demo_history && <SyntheticPill />}
        </span>
      ),
    },
  ];

  return (
    <ConsoleShell>
      <Card title="Reservations" description="Every hold a customer placed, how the store handled it and how it ended.">
        <div className="filters">
          {FILTERS.map(([value, text]) => (
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
        <HideSyntheticToggle hide={hideSynthetic} onChange={setHideSynthetic} hidden={hidden} />
        {list.error && <p className="error">{list.error}</p>}
        {!list.data && !list.error && <Skeleton lines={4} />}
        {list.data && shown.length === 0 ? (
          <EmptyState>No reservations here yet. Shoppers place holds from the chat.</EmptyState>
        ) : (
          list.data && (
            <Table
              caption="Reservations"
              columns={columns}
              rows={shown}
              rowKey={(r) => r.reservation_id}
              onRowClick={(r) => {
                if (r.conversation_id) navigate(`/brand/conversations?c=${encodeURIComponent(r.conversation_id)}`);
              }}
            />
          )
        )}
        <p className="muted small">Select a reservation to open its conversation.</p>
      </Card>
    </ConsoleShell>
  );
}
