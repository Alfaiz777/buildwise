import { Minus, Plus, Printer, Receipt, Search, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, errorMessage, useLoad } from '../../components/ConsoleShell';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Menu,
  ProductThumb,
  Segmented,
  Skeleton,
  useToast,
} from '../../components/ui';
import { formatPrice } from '../brand/types';
import { PageHeader } from '../platform/PlatformChrome';
import './store.css';
import './sales.css';

/** A row of the store's stock, as the stock page reads it. */
interface StockItem {
  sku: string;
  product_title: string | null;
  variant_title: string | null;
  image_url?: string | null;
  available_quantity: number;
  reserved_quantity: number;
  offline_price: number;
}

/** A walk-in sale's invoice (never a customer). */
export interface Sale {
  sale_id: string;
  invoice_number: string;
  lines: {
    sku: string;
    product_title: string | null;
    variant_title: string | null;
    quantity: number;
    unit_price: number;
    line_total: number;
  }[];
  units: number;
  total: number;
  currency: string;
  payment_method: 'CASH' | 'UPI' | 'CARD' | 'OTHER';
  status: 'RECORDED' | 'VOIDED';
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}
interface SalesList {
  sales: Sale[];
  totals: { invoices: number; units: number; value: number; voided: number; currency: string };
}

const PAYMENT: { value: Sale['payment_method']; label: string }[] = [
  { value: 'CASH', label: 'Cash' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CARD', label: 'Card' },
  { value: 'OTHER', label: 'Other' },
];
const paymentWord = (p: Sale['payment_method']) => PAYMENT.find((x) => x.value === p)?.label ?? p;
const itemName = (l: { product_title: string | null; variant_title: string | null; sku: string }) =>
  `${l.product_title ?? l.sku}${l.variant_title ? ` ${l.variant_title}` : ''}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const money = (n: number) => formatPrice(n, 'INR');

/**
 * Store Console → Sales (Change 19): the invoice of a walk-in sale — a shopper who came in on
 * their own. Recording it takes the sold units out of the store's stock at once, so Qwikspot
 * never offers a product this store has just sold. Only available stock can be sold: units held
 * for a Qwikspot shopper stay theirs. A sale can be voided within 24 hours (the stock comes back).
 */
export function StoreSales() {
  const me = useMe();
  const api = useApi();
  const toast = useToast();
  const storeId = me.scope === 'RETAIL' ? me.store.store_id : '';
  const [period, setPeriod] = useState<'1' | '7'>('1');
  const stock = useLoad(
    useCallback(
      () => api.get<{ items: StockItem[] }>(`/api/retail/stores/${encodeURIComponent(storeId)}/inventory`),
      [api, storeId],
    ),
  );
  const list = useLoad(
    useCallback(
      () => api.get<SalesList>(`/api/retail/stores/${encodeURIComponent(storeId)}/sales?days=${period}`),
      [api, storeId, period],
    ),
  );
  const [cart, setCart] = useState<Record<string, number>>({});
  const [payment, setPayment] = useState<Sale['payment_method']>('CASH');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const [voiding, setVoiding] = useState<Sale | null>(null);
  const [reason, setReason] = useState('');

  const items = useMemo(() => stock.data?.items ?? [], [stock.data]);
  const bySku = useMemo(() => new Map(items.map((i) => [i.sku, i])), [items]);
  if (me.scope !== 'RETAIL') return <Navigate to="/app" replace />;

  const q = query.trim().toLowerCase();
  const matches = items
    .filter((i) => !q || `${i.product_title ?? ''} ${i.variant_title ?? ''} ${i.sku}`.toLowerCase().includes(q))
    .slice(0, 8);
  const lines = Object.entries(cart)
    .filter(([, n]) => n > 0)
    .map(([sku, quantity]) => ({ item: bySku.get(sku)!, quantity }))
    .filter((l) => l.item);
  const total = lines.reduce((n, l) => n + l.item.offline_price * l.quantity, 0);
  const setQty = (sku: string, n: number) => {
    const max = bySku.get(sku)?.available_quantity ?? 0;
    setCart((c) => ({ ...c, [sku]: Math.max(0, Math.min(max, n)) }));
  };

  const record = async () => {
    setBusy(true);
    setError(null);
    try {
      const sale = await api.post<Sale>(`/api/retail/stores/${encodeURIComponent(storeId)}/sales`, {
        lines: lines.map((l) => ({ sku: l.item.sku, quantity: l.quantity })),
        payment_method: payment,
      });
      toast.show(`${sale.invoice_number} recorded — ${sale.units} unit${sale.units === 1 ? '' : 's'} left your stock.`);
      setCart({});
      setReceipt(sale);
      stock.reload();
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
      stock.reload();
    } finally {
      setBusy(false);
    }
  };

  const voidSale = async () => {
    if (!voiding) return;
    setBusy(true);
    try {
      const sale = await api.post<Sale>(
        `/api/retail/stores/${encodeURIComponent(storeId)}/sales/${encodeURIComponent(voiding.sale_id)}/void`,
        { reason: reason.trim() },
      );
      toast.show(`${sale.invoice_number} voided — the stock is back.`);
      setVoiding(null);
      setReason('');
      stock.reload();
      list.reload();
    } catch (err) {
      toast.show(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const t = list.data?.totals;
  return (
    <ConsoleShell>
      <PageHeader
        title="Sales"
        purpose="Record a walk-in sale. The units leave your stock at once, so Qwikspot never offers what you just sold."
      />
      <section className="sl-strip" aria-label="Sales so far">
        <div className="pf-tile">
          <span className="pf-tile__label">{period === '1' ? 'Invoices today' : 'Invoices, 7 days'}</span>
          <span className="pf-tile__value pf-tile__value--sm">{t?.invoices ?? '—'}</span>
          <span className="pf-tile__sub">{t ? `${t.units} unit${t.units === 1 ? '' : 's'} sold` : ' '}</span>
        </div>
        <div className="pf-tile">
          <span className="pf-tile__label">{period === '1' ? 'Sold today' : 'Sold, 7 days'}</span>
          <span className="pf-tile__value pf-tile__value--sm">{t ? money(t.value) : '—'}</span>
          <span className="pf-tile__sub">walk-in shoppers, at your prices</span>
        </div>
      </section>

      <div className={`sl-layout${lines.length > 0 ? ' has-lines' : ''}`}>
        <Card title="New sale" className="sl-new" description="Add what the shopper is buying from your stock.">
          <label className="sl-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="Find a product"
              placeholder="Product name or SKU"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {!stock.data && !stock.error && <Skeleton lines={3} />}
          {stock.error && <p className="error">{stock.error}</p>}
          {stock.data && items.length === 0 && (
            <EmptyState>No stock yet. Your brand imports it from its retail file.</EmptyState>
          )}
          <ul className="sl-pick" aria-label="Products">
            {matches.map((i) => {
              const inCart = cart[i.sku] ?? 0;
              const left = i.available_quantity - inCart;
              return (
                <li key={i.sku}>
                  <ProductThumb src={i.image_url ?? null} name={i.product_title ?? i.sku} size={36} />
                  <span className="sl-pick__name">
                    <strong>{itemName(i)}</strong>
                    <span className="small muted">
                      <span className="mono">{i.sku}</span> · {money(i.offline_price)} ·{' '}
                      {i.available_quantity > 0 ? `${i.available_quantity} available` : 'none available'}
                      {i.reserved_quantity > 0 && ` (${i.reserved_quantity} held for Qwikspot)`}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={left <= 0}
                    aria-label={`Add ${itemName(i)}`}
                    onClick={() => setQty(i.sku, inCart + 1)}
                  >
                    <Plus size={14} aria-hidden="true" /> Add
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Invoice" className="sl-bill">
          {lines.length === 0 ? (
            <p className="muted small">Nothing added yet.</p>
          ) : (
            <ul className="sl-lines" aria-label="Invoice lines">
              {lines.map(({ item, quantity }) => (
                <li key={item.sku}>
                  <span className="sl-lines__name">
                    {itemName(item)}
                    <span className="small muted">{money(item.offline_price)} each</span>
                  </span>
                  <span className="sl-qty" role="group" aria-label={`Quantity of ${itemName(item)}`}>
                    <button
                      type="button"
                      className="ui-icon-button"
                      aria-label={`One less ${itemName(item)}`}
                      onClick={() => setQty(item.sku, quantity - 1)}
                    >
                      <Minus size={14} aria-hidden="true" />
                    </button>
                    <span className="sl-qty__n" aria-live="polite">
                      {quantity}
                    </span>
                    <button
                      type="button"
                      className="ui-icon-button"
                      aria-label={`One more ${itemName(item)}`}
                      disabled={quantity >= item.available_quantity}
                      onClick={() => setQty(item.sku, quantity + 1)}
                    >
                      <Plus size={14} aria-hidden="true" />
                    </button>
                  </span>
                  <span className="sl-lines__total">{money(item.offline_price * quantity)}</span>
                  <button
                    type="button"
                    className="ui-icon-button"
                    aria-label={`Remove ${itemName(item)}`}
                    onClick={() => setQty(item.sku, 0)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="sl-bill__pay">
            <span className="small muted">Paid by</span>
            <Segmented label="Payment" value={payment} options={PAYMENT} onChange={setPayment} />
          </div>
          <div className="sl-bill__total">
            <span>Total</span>
            <strong>{money(total)}</strong>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button
            variant="brand"
            className="sl-bill__record"
            disabled={lines.length === 0}
            loading={busy}
            icon={<Receipt size={16} aria-hidden="true" />}
            onClick={() => void record()}
          >
            Record sale
          </Button>
          <p className="small muted">
            No customer details are recorded. Units held for Qwikspot shoppers can't be sold here.
          </p>
        </Card>
      </div>

      <Card
        title="Invoices"
        actions={
          <Segmented
            label="Period"
            value={period}
            options={[
              { value: '1', label: 'Today' },
              { value: '7', label: '7 days' },
            ]}
            onChange={setPeriod}
          />
        }
      >
        {!list.data && !list.error && <Skeleton lines={2} />}
        {list.error && <p className="error">{list.error}</p>}
        {list.data && list.data.sales.length === 0 && (
          <EmptyState icon={<Receipt size={22} />}>
            No walk-in sales recorded {period === '1' ? 'today' : 'in 7 days'}.
          </EmptyState>
        )}
        {list.data && list.data.sales.length > 0 && (
          <ul className="sl-invoices" aria-label="Invoices">
            {list.data.sales.map((s) => (
              <li key={s.sale_id} className={s.status === 'VOIDED' ? 'is-voided' : undefined}>
                <span className="sl-invoices__no mono">{s.invoice_number}</span>
                <span className="sl-invoices__what">
                  {s.lines.map((l) => `${l.quantity} × ${itemName(l)}`).join(', ')}
                  <span className="small muted">
                    {period === '1' ? time(s.created_at) : dateTime(s.created_at)} · {paymentWord(s.payment_method)}
                  </span>
                </span>
                <span className="sl-invoices__total">
                  {money(s.total)}
                  {s.status === 'VOIDED' && <Badge tone="neutral">Voided</Badge>}
                </span>
                <Menu
                  label={`More for ${s.invoice_number}`}
                  items={[
                    { label: 'View receipt', onSelect: () => setReceipt(s) },
                    ...(s.status === 'RECORDED'
                      ? [{ label: 'Void…', tone: 'danger' as const, onSelect: () => setVoiding(s) }]
                      : []),
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Drawer
        open={receipt !== null}
        title={receipt ? `Receipt ${receipt.invoice_number}` : 'Receipt'}
        onClose={() => setReceipt(null)}
      >
        {receipt && (
          <div className="sl-receipt" id="sl-receipt">
            <header>
              <strong>{me.store.store_name}</strong>
              <span className="small muted">{me.store.address ?? me.store.city}</span>
              <span className="small">
                {receipt.invoice_number} · {dateTime(receipt.created_at)}
              </span>
            </header>
            <table aria-label="Receipt lines">
              <tbody>
                {receipt.lines.map((l) => (
                  <tr key={l.sku}>
                    <td>
                      {l.quantity} × {itemName(l)}
                    </td>
                    <td className="is-numeric">{money(l.line_total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total · {paymentWord(receipt.payment_method)}</th>
                  <th className="is-numeric">{money(receipt.total)}</th>
                </tr>
              </tfoot>
            </table>
            {receipt.status === 'VOIDED' && (
              <p className="small">
                <Badge tone="neutral">Voided</Badge> {receipt.void_reason}
              </p>
            )}
            <Button variant="secondary" icon={<Printer size={16} aria-hidden="true" />} onClick={() => window.print()}>
              Print
            </Button>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={voiding !== null}
        title={voiding ? `Void ${voiding.invoice_number}?` : 'Void'}
        confirmLabel="Void sale"
        tone="danger"
        busy={busy}
        confirmDisabled={reason.trim().length < 3}
        onConfirm={() => void voidSale()}
        onCancel={() => {
          setVoiding(null);
          setReason('');
        }}
      >
        <p>The units go back into your stock. Use it for a mistake or a same-day return (within 24 hours).</p>
        <label className="sl-void">
          <span>Why?</span>
          <input
            aria-label="Why is this sale voided?"
            value={reason}
            maxLength={200}
            placeholder="e.g. Entered twice"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </ConfirmDialog>
    </ConsoleShell>
  );
}
