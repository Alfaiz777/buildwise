import { useCallback } from 'react';
import { useApi } from '../../api/apiContext';
import { useLoad } from '../../components/ConsoleShell';
import { Drawer, EmptyState, ErrorState, Skeleton } from '../../components/ui';
import { formatDateTime } from '../brand/types';

/** Change 19: why a stock row last changed, in the store's words. */
export const STOCK_REASON: Record<string, string> = {
  RETAIL_IMPORT: 'Retail file import',
  IN_STORE_SALE: 'In-store sale',
  SALE_VOIDED: 'Sale voided',
  QWIKSPOT_PICKUP: 'Qwikspot pickup',
  HOLD_PLACED: 'Held for a Qwikspot shopper',
  HOLD_RELEASED: 'Qwikspot hold released',
};
export const stockReason = (reason: string | null | undefined) => (reason ? (STOCK_REASON[reason] ?? reason) : null);

interface Movement {
  sku: string;
  delta: number;
  quantity_after: number;
  reason: string;
  invoice_number: string | null;
  at: string;
}

/** The recorded stock movements of one SKU at the Retail Admin's store (sales and voids). */
export function StockHistoryDrawer({
  storeId,
  sku,
  name,
  onClose,
}: {
  storeId: string;
  sku: string | null;
  name: string;
  onClose: () => void;
}) {
  const api = useApi();
  const history = useLoad(
    useCallback(
      () =>
        sku
          ? api.get<{ movements: Movement[] }>(
              `/api/retail/stores/${encodeURIComponent(storeId)}/stock-history?sku=${encodeURIComponent(sku)}`,
            )
          : Promise.resolve({ movements: [] as Movement[] }),
      [api, storeId, sku],
    ),
  );
  const moves = history.data?.movements ?? [];
  return (
    <Drawer open={sku !== null} title={`Stock history · ${name}`} onClose={onClose}>
      {history.error && <ErrorState message={history.error} onRetry={history.reload} />}
      {!history.data && !history.error && <Skeleton lines={3} label="Loading history" />}
      {history.data && moves.length === 0 && (
        <EmptyState>
          No in-store sales of this product yet. Imports and Qwikspot holds show on the row itself.
        </EmptyState>
      )}
      {moves.length > 0 && (
        <ul className="sl-moves" aria-label="Stock movements">
          {moves.map((m, i) => (
            <li key={`${m.at}-${i}`}>
              <span className={`sl-moves__delta ${m.delta < 0 ? 'is-out' : 'is-in'}`}>
                {m.delta > 0 ? `+${m.delta}` : m.delta}
              </span>
              <span>
                <span>
                  <strong>{stockReason(m.reason)}</strong>
                  {m.invoice_number && <span className="mono small"> · {m.invoice_number}</span>}
                </span>
                <span className="small muted">
                  {formatDateTime(m.at)} · {m.quantity_after} on hand after
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
