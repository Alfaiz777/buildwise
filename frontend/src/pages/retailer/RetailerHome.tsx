import { useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useApi, type Store } from '../../api/apiContext';
import { ConsoleShell, Section, useLoad } from '../../components/ConsoleShell';
import { formatDateTime } from '../brand/types';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function hoursText(hours: Store['store_hours']): string | null {
  if (!hours) return null;
  const days = WEEKDAYS.filter((d) => hours[d]).map((d) => `${d.slice(0, 3)} ${hours[d]}`);
  if (days.length === 0) return null;
  return `${days.join(' · ')}${hours.timezone ? ` (${hours.timezone})` : ''}`;
}

interface StockItem {
  sku: string;
  product_title: string | null;
  variant_title: string | null;
  quantity: number;
  reserved_quantity: number;
  available_quantity: number;
  availability_status: string;
  last_updated_at: string | null;
}

/**
 * Retailer Console for RETAIL_ADMIN: exactly ONE physical store, the one the backend
 * verified at sign-in (docs/11_INTERFACE_CONTRACT.md). There is no store picker and no
 * list of the retailer's other stores: a Retail Admin never operates another store.
 * M3 adds the read-only stock of this store; reservations arrive in a later milestone.
 */
export function RetailerHome() {
  const me = useMe();
  if (me.scope !== 'RETAIL') return <Navigate to="/" replace />;
  return <RetailerStore retailerName={me.retailer_name} store={me.store} />;
}

function RetailerStore({ retailerName, store }: { retailerName: string; store: Store }) {
  const api = useApi();
  const stock = useLoad(
    useCallback(
      () => api.get<{ items: StockItem[] }>(`/api/retail/stores/${encodeURIComponent(store.store_id)}/inventory`),
      [api, store.store_id],
    ),
  );

  return (
    <ConsoleShell>
      <Section title="Your store">
        <dl>
          <dt>Retailer</dt>
          <dd>{retailerName}</dd>
          <dt>Store</dt>
          <dd>{store.store_name}</dd>
          <dt>Store ID</dt>
          <dd className="mono">{store.store_id}</dd>
          <dt>City</dt>
          <dd>{store.city}</dd>
          <dt>Address</dt>
          <dd>{store.address ?? <span className="muted">not provided</span>}</dd>
          <dt>Status</dt>
          <dd>{store.store_status}</dd>
          <dt>Hours</dt>
          <dd>{hoursText(store.store_hours) ?? <span className="muted">not provided</span>}</dd>
        </dl>
      </Section>
      <Section title="Store stock">
        {stock.error && <p className="error">{stock.error}</p>}
        {stock.data?.items.length === 0 ? (
          <p className="muted">
            No stock has been imported for this store yet. Your brand imports it from its retail file.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th>Quantity</th>
                <th>Reserved</th>
                <th>Available</th>
                <th>Last updated</th>
              </tr>
            </thead>
            <tbody>
              {stock.data?.items.map((item) => (
                <tr key={item.sku}>
                  <td className="mono">{item.sku}</td>
                  <td>
                    {item.product_title ?? '—'}
                    {item.variant_title && <span className="muted small"> · {item.variant_title}</span>}
                  </td>
                  <td>{item.quantity}</td>
                  <td>{item.reserved_quantity}</td>
                  <td>
                    {item.available_quantity}{' '}
                    {item.availability_status !== 'IN_STOCK' && (
                      <span className="badge">{item.availability_status.replace('_', ' ').toLowerCase()}</span>
                    )}
                  </td>
                  <td className="small">{formatDateTime(item.last_updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Read-only. Customer reservations for this store appear here in a later milestone.</p>
      </Section>
    </ConsoleShell>
  );
}
