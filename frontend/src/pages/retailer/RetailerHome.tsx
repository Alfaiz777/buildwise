import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useApi, type Store } from '../../api/apiContext';
import { Loading, ErrorState } from '../../components/States';
import { label } from '../../lib/labels';
import { ConsoleShell, Section, useLoad } from '../../components/ConsoleShell';
import { formatDateTime } from '../brand/types';
import { RetailerQueue, WeekStrip } from './RetailerQueue';

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
  /** Older than the brand's retail_freshness_hours (Change 14, G1). */
  stale?: boolean;
}

/**
 * Retailer Console for RETAIL_ADMIN: exactly ONE physical store, the one the backend
 * verified at sign-in (docs/11_INTERFACE_CONTRACT.md). There is no store picker and no
 * list of the retailer's other stores: a Retail Admin never operates another store.
 * M3: the read-only stock of this store. M5: "Reserved" rises when a customer holds a
 * product and falls when the hold is cancelled or expires. M6: the reservation queue —
 * confirm, ready, customer arrived, complete with the pickup code, or refuse with a reason.
 */
export function RetailerHome({ autoPoll = false }: { autoPoll?: boolean }) {
  const me = useMe();
  if (me.scope !== 'RETAIL') return <Navigate to="/" replace />;
  return <RetailerStore retailerName={me.retailer_name} store={me.store} autoPoll={autoPoll} />;
}

function RetailerStore({ retailerName, store, autoPoll }: { retailerName: string; store: Store; autoPoll: boolean }) {
  const api = useApi();
  const stock = useLoad(
    useCallback(
      () => api.get<{ items: StockItem[] }>(`/api/retail/stores/${encodeURIComponent(store.store_id)}/inventory`),
      [api, store.store_id],
    ),
  );
  const { reload } = stock;
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!autoPoll) return;
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, [autoPoll, reload]);

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
          <dd>{label(store.store_status)}</dd>
          <dt>Hours</dt>
          <dd>{hoursText(store.store_hours) ?? <span className="muted">not provided</span>}</dd>
        </dl>
      </Section>
      <Section title="Reservations">
        <WeekStrip storeId={store.store_id} reloadKey={reloadKey} />
        <RetailerQueue
          autoPoll={autoPoll}
          onChanged={() => {
            reload();
            setReloadKey((k) => k + 1);
          }}
        />
      </Section>
      <Section title="Store stock">
        <button type="button" className="secondary" onClick={reload}>
          Refresh
        </button>
        {stock.error && <ErrorState message={stock.error} onRetry={reload} />}
        {!stock.data && !stock.error && <Loading what="Loading stock" />}
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
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Product</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Reserved</th>
                  <th scope="col">Available</th>
                  <th scope="col">Stock as of</th>
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
                        <span className="badge">{label(item.availability_status)}</span>
                      )}
                    </td>
                    <td className="small">
                      {formatDateTime(item.last_updated_at)} {item.stale && <span className="badge stale">stale</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Read-only. Reserved = units held for customers at this store (released when a hold is cancelled or expires);
          available = quantity − reserved.{autoPoll ? ' This table refreshes every 15 seconds.' : ''}
        </p>
      </Section>
    </ConsoleShell>
  );
}
