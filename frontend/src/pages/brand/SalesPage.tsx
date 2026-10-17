import { Receipt } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { Badge, Card, EmptyState, ErrorState, RingGauge, Segmented, Skeleton, Tip } from '../../components/ui';
import { PageHeader } from '../platform/PlatformChrome';
import { AskScope } from './askQwikspot';
import { formatDateTime, formatPrice } from './types';
import './brand.css';
import '../retailer/sales.css';

interface Totals {
  invoices: number;
  units: number;
  value: number;
  voided: number;
  currency: string;
}
interface StoreRow {
  store_id: string;
  store_name: string;
  invoices: number;
  units: number;
  value: number;
  pickups: number;
  pickup_value: number;
}
interface ProductRow {
  sku: string;
  product_title: string | null;
  variant_title: string | null;
  units: number;
  value: number;
}
interface RecentSale {
  sale_id: string;
  store_name: string;
  invoice_number: string;
  units: number;
  total: number;
  payment_method: string;
  status: 'RECORDED' | 'VOIDED';
  created_at: string;
  lines: { sku: string; product_title: string | null; variant_title: string | null; quantity: number }[];
}
export interface BrandSales {
  period: { days: number; from: string; to: string };
  walk_in: Totals;
  qwikspot_pickups: { pickups: number; value: number; currency: string };
  qwikspot_share_pct: number | null;
  by_store: StoreRow[];
  by_product: ProductRow[];
  recent: RecentSale[];
}

const money = (n: number) => formatPrice(n, 'INR');
const name = (p: { product_title: string | null; variant_title: string | null; sku: string }) =>
  `${p.product_title ?? p.sku}${p.variant_title ? ` ${p.variant_title}` : ''}`;

/**
 * Brand Console → Sales (Change 19): the walk-in sales each store records in its Store Console,
 * beside the Qwikspot pickups at the same stores. Walk-in sales are the store's own offline
 * sales; they are never counted as Qwikspot conversions. Pickup value uses the stores' current
 * offline prices (est.).
 */
export function SalesPage() {
  const api = useApi();
  const [days, setDays] = useState<7 | 28>(7);
  const load = useLoad(useCallback(() => api.get<BrandSales>(`/api/brand/sales?days=${days}`), [api, days]));
  const d = load.data;
  const most = Math.max(1, ...(d?.by_store ?? []).map((s) => Math.max(s.value, s.pickup_value)));
  return (
    <ConsoleShell>
      <AskScope days={days} includeHistory />
      <PageHeader
        title="Sales"
        purpose="Walk-in sales your stores record, beside Qwikspot pickups. Every sale updates the stock Qwikspot offers."
      />
      <div className="pf-filters">
        <Segmented
          label="Period"
          value={days}
          options={[
            { value: 7, label: '7 days' },
            { value: 28, label: '28 days' },
          ]}
          onChange={setDays}
        />
      </div>
      {load.error && <ErrorState message={load.error} onRetry={load.reload} />}
      {!d && !load.error && <Skeleton lines={4} label="Loading sales" />}
      {d && (
        <>
          <section className="sl-tiles" aria-label="Sales totals">
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Walk-in sales</span>
              <span className="pf-tile__value">{money(d.walk_in.value)}</span>
              <span className="pf-tile__sub">
                {d.walk_in.invoices} invoice{d.walk_in.invoices === 1 ? '' : 's'} · {d.walk_in.units} unit
                {d.walk_in.units === 1 ? '' : 's'}
              </span>
            </div>
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Qwikspot pickups</span>
              <span className="pf-tile__value">
                {money(d.qwikspot_pickups.value)}
                <span className="pf-tile__est">est.</span>
              </span>
              <span className="pf-tile__sub">
                {d.qwikspot_pickups.pickups} picked-up hold{d.qwikspot_pickups.pickups === 1 ? '' : 's'}
              </span>
            </div>
            <div className="pf-tile pf-tile--lg pf-tile--ring">
              <RingGauge pct={d.qwikspot_share_pct} size={52} />
              <div>
                <span className="pf-tile__label">
                  <Tip text="Qwikspot pickups ÷ (walk-in sales + Qwikspot pickups), by value.">Qwikspot share</Tip>
                </span>
                <span className="pf-tile__value pf-tile__value--sm">
                  {d.qwikspot_share_pct === null ? '—' : `${d.qwikspot_share_pct}%`}
                </span>
                <span className="pf-tile__sub">of the stores' offline sales</span>
              </div>
            </div>
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Voided</span>
              <span className="pf-tile__value pf-tile__value--sm">{d.walk_in.voided}</span>
              <span className="pf-tile__sub">mistakes or same-day returns; stock given back</span>
            </div>
          </section>

          <div className="sl-brand-grid">
            <Card title="By store" description="Walk-in sales and Qwikspot pickups at each store.">
              {d.by_store.length === 0 ? (
                <EmptyState icon={<Receipt size={22} />}>No sales or pickups in this period.</EmptyState>
              ) : (
                <ul className="sl-stores" aria-label="Sales by store">
                  {d.by_store.map((s) => (
                    <li key={s.store_id}>
                      <span className="sl-stores__name">
                        <strong>{s.store_name}</strong>
                        <span className="small muted">
                          {s.invoices} invoice{s.invoices === 1 ? '' : 's'} · {s.pickups} pickup
                          {s.pickups === 1 ? '' : 's'}
                        </span>
                      </span>
                      <span className="sl-bars">
                        <span className="sl-bar">
                          <span className="sl-bar__label">Walk-in</span>
                          <span className="sl-bar__track">
                            <span
                              className="sl-bar__fill sl-bar__fill--walkin"
                              style={{ width: `${(s.value / most) * 100}%` }}
                            />
                          </span>
                          <span className="sl-bar__value">{money(s.value)}</span>
                        </span>
                        <span className="sl-bar">
                          <span className="sl-bar__label">Qwikspot</span>
                          <span className="sl-bar__track">
                            <span
                              className="sl-bar__fill sl-bar__fill--qwikspot"
                              style={{ width: `${(s.pickup_value / most) * 100}%` }}
                            />
                          </span>
                          <span className="sl-bar__value">{money(s.pickup_value)}</span>
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Top products in store" description="What walk-in shoppers bought.">
              {d.by_product.length === 0 ? (
                <p className="muted small">No walk-in sales in this period.</p>
              ) : (
                <ol className="sl-products" aria-label="Top products in store">
                  {d.by_product.slice(0, 8).map((p) => (
                    <li key={p.sku}>
                      <span>
                        {name(p)}
                        <span className="mono small muted"> {p.sku}</span>
                      </span>
                      <span className="sl-products__n">
                        {p.units} · {money(p.value)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>

          <Card title="Recent invoices" description="No customer details are recorded on a walk-in invoice.">
            {d.recent.length === 0 ? (
              <p className="muted small">No walk-in sales in this period.</p>
            ) : (
              <div className="ui-table-wrap">
                <table className="ui-table" aria-label="Recent invoices">
                  <thead>
                    <tr>
                      <th scope="col">Invoice</th>
                      <th scope="col">Store</th>
                      <th scope="col">Items</th>
                      <th scope="col">When</th>
                      <th scope="col" className="is-numeric">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.recent.map((s) => (
                      <tr key={s.sale_id} className={s.status === 'VOIDED' ? 'is-voided' : undefined}>
                        <td data-label="Invoice" className="mono">
                          {s.invoice_number} {s.status === 'VOIDED' && <Badge tone="neutral">Voided</Badge>}
                        </td>
                        <td data-label="Store">{s.store_name}</td>
                        <td data-label="Items">{s.lines.map((l) => `${l.quantity} × ${name(l)}`).join(', ')}</td>
                        <td data-label="When">{formatDateTime(s.created_at)}</td>
                        <td data-label="Total" className="is-numeric">
                          {money(s.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <p className="small muted">
            Walk-in sales are your stores' own sales to shoppers who came in without Qwikspot. They lower the stock
            Qwikspot offers, but they are never counted as Qwikspot conversions.
          </p>
        </>
      )}
    </ConsoleShell>
  );
}
