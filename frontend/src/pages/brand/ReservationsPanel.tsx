import { useCallback } from 'react';
import { useApi } from '../../api/apiContext';
import { useLoad } from '../../components/ConsoleShell';
import { humanize, type ReservationRow } from './conversationTypes';
import { formatDateTime } from './types';

/**
 * Brand Console reservations list (GET /api/reservations, docs/06 §14.4): read-only in M5.
 * Customers are masked; store fulfilment actions arrive with the Retailer queue (M6).
 */
export function ReservationsPanel({ reloadKey }: { reloadKey: number }) {
  const api = useApi();
  const list = useLoad(
    // reloadKey re-runs the load after a simulator message or a due-work run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useCallback(() => api.get<{ reservations: ReservationRow[] }>('/api/reservations'), [api, reloadKey]),
  );
  if (list.error) return <p className="error">{list.error}</p>;
  if (list.data && list.data.reservations.length === 0) {
    return <p className="muted">No reservations yet. A customer can hold a product from the simulator.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Store</th>
          <th>Product</th>
          <th>Customer</th>
          <th>Created</th>
          <th>Expires</th>
        </tr>
      </thead>
      <tbody>
        {list.data?.reservations.map((r) => (
          <tr key={r.reservation_id} className={r.active ? '' : 'muted'}>
            <td>
              <span className="badge">{humanize(r.status)}</span>
            </td>
            <td>{r.store_name}</td>
            <td>
              {r.product_title ?? r.sku}
              {r.variant_title && <span className="muted small"> · {r.variant_title}</span>}
              {r.quantity > 1 && ` × ${r.quantity}`}
            </td>
            <td className="small">{r.customer_display}</td>
            <td className="small">{formatDateTime(r.created_at)}</td>
            <td className="small">{formatDateTime(r.expires_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
