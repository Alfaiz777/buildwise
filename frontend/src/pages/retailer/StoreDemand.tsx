import { useCallback, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { Card, EmptyState, ErrorState, Skeleton } from '../../components/ui';
import { WeekdayChart } from '../brand/InsightCharts';
import { REFUSAL_LABEL } from './RetailerQueue';

export interface StoreInsights {
  store_id: string;
  period: { days: number; from: string; to: string; timezone: string };
  demo_history: { included: boolean };
  missed: { sku: string; label: string; weekday: string; reason: string; count: number }[];
  fill_rate: {
    weekday: string;
    nearest: number;
    had_stock: number;
    fill_pct: number;
    refusals: Record<string, number>;
  }[];
  refusals: Record<string, number>;
  suggestions: { rule: string; text: string }[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const REASON: Record<string, string> = {
  OUT_OF_STOCK: 'out of stock',
  CLOSED: 'closed',
  INACTIVE: 'store inactive',
  RESERVATIONS_DISABLED: 'reservations off',
  TOO_FAR: 'too far',
};
const ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * Store Console → Demand near you (docs/11 §5; Change 16, UI-4; audit P1-3): this store's
 * own slice of the brand's insights — where it was the nearest store but could not
 * serve, its fill rate by weekday, its refusals and the brand's suggestions for it.
 * Counts only; never a customer, and never another store's numbers.
 */
export function StoreDemand() {
  const me = useMe();
  const api = useApi();
  const [days, setDays] = useState<7 | 28>(7);
  const [includeHistory, setIncludeHistory] = useState(true);
  const storeId = me.scope === 'RETAIL' ? me.store.store_id : '';
  const data = useLoad(
    useCallback(
      () =>
        api.get<StoreInsights>(
          `/api/retail/stores/${encodeURIComponent(storeId)}/insights?days=${days}&include_history=${includeHistory}`,
        ),
      [api, storeId, days, includeHistory],
    ),
  );
  if (me.scope !== 'RETAIL') return <Navigate to="/app" replace />;
  const d = data.data;
  const refusals = d ? Object.entries(d.refusals).filter(([, n]) => n > 0) : [];
  const nothing = d && d.missed.length === 0 && d.fill_rate.length === 0 && d.suggestions.length === 0;
  // The chart reads "when you were the nearest store" as lookups and "you had none" as the misses.
  const chartDays = ORDER.map((weekday) => {
    const f = d?.fill_rate.find((x) => x.weekday === weekday);
    const nearest = f?.nearest ?? 0;
    const missedCount = nearest - (f?.had_stock ?? 0);
    return {
      weekday,
      lookups: nearest,
      no_store: missedCount,
      no_store_pct: nearest === 0 ? 0 : Math.round((missedCount / nearest) * 100),
    };
  });
  const worst = [...chartDays].filter((x) => x.no_store > 0).sort((a, b) => b.no_store - a.no_store)[0];

  return (
    <ConsoleShell>
      <Card
        title="Demand near you"
        description={`What shoppers asked ${me.brand_name} for near ${me.store.store_name}, from the brand's records. Counts only — never a customer.`}
      >
        <div className="overview-head">
          <div className="filters" role="group" aria-label="Period">
            {([7, 28] as const).map((n) => (
              <button
                key={n}
                type="button"
                className={days === n ? '' : 'secondary'}
                aria-pressed={days === n}
                onClick={() => setDays(n)}
              >
                Last {n} days
              </button>
            ))}
          </div>
          <label className="small">
            <input type="checkbox" checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} />{' '}
            Include synthetic history
          </label>
          {d && <span className="muted small">Weekdays in store time ({d.period.timezone}).</span>}
        </div>
        {data.error && <ErrorState message={data.error} onRetry={data.reload} />}
        {!d && !data.error && <Skeleton lines={3} />}
        {nothing && (
          <EmptyState>
            Nothing to show yet. Demand appears here as shoppers ask {me.brand_name} for products near your store.
          </EmptyState>
        )}
      </Card>

      {d && !nothing && (
        <>
          <Card title="Missed demand" description="You were the nearest store, but couldn't serve these shoppers.">
            {d.missed.length === 0 ? (
              <p className="muted">
                No missed demand near you in the last {d.period.days} days. When shoppers ask for something you don't
                have, it shows here.
              </p>
            ) : (
              <div className="ui-table-wrap">
                <table aria-label="Missed demand">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Day</th>
                      <th>Times</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.missed.map((m) => (
                      <tr key={`${m.sku}-${m.weekday}-${m.reason}`}>
                        <td>{m.label}</td>
                        <td>{cap(m.weekday)}</td>
                        <td>{m.count}</td>
                        <td>{REASON[m.reason] ?? m.reason.toLowerCase().replace(/_/g, ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="When you were the nearest store"
            description="How often you had what the shopper asked for, by weekday."
          >
            {d.fill_rate.length === 0 ? (
              <p className="muted">No store lookups have chosen you as the nearest store yet.</p>
            ) : (
              <WeekdayChart
                days={chartDays}
                problemDay={worst?.weekday ?? null}
                caption=""
                keys={['Times you were the nearest store', 'times you had none']}
              />
            )}
            {refusals.length > 0 && (
              <p className="small">
                Holds you refused:{' '}
                {refusals.map(([reason, n]) => `${REFUSAL_LABEL[reason] ?? reason} ${n}`).join(' · ')}
              </p>
            )}
          </Card>

          <Card
            title={`From ${me.brand_name}`}
            description="Suggestions about your store. Shown here only — nothing is sent."
          >
            {d.suggestions.length === 0 ? (
              <p className="muted">No suggestions for your store in this period.</p>
            ) : (
              <ul className="suggestions">
                {d.suggestions.map((s) => (
                  <li key={s.text}>{s.text}</li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </ConsoleShell>
  );
}
