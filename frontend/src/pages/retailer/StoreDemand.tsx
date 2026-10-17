import { CheckCircle2, Info, Lightbulb } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { AiButton, Card, EmptyState, ErrorState, ProductThumb, RingGauge, Skeleton, Tip } from '../../components/ui';
import { WeekdayChart } from '../brand/InsightCharts';
import { AskScope, useAskQwikspot } from '../brand/askQwikspot';
import { AskAction, PageHeader, PeriodControls } from '../platform/PlatformChrome';
import { REFUSAL_LABEL } from './RetailerQueue';
import './store.css';

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

/** "Ask Qwikspot why →" on a missed product (a component, so it renders inside the shell). */
function AskWhy({ product }: { product: string }) {
  const { ask } = useAskQwikspot();
  return (
    <AiButton size="sm" quiet onClick={() => ask(`Why did shoppers near me miss ${product}?`)}>
      Ask Qwikspot why
    </AiButton>
  );
}

/** A horizontal bar list: one row per item, the bar its share of the largest. */
function BarList({
  rows,
  tone,
  label,
}: {
  rows: { key: string; text: string; count: number }[];
  tone: string;
  label: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="st-bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key}>
          <span className="st-bars__text">{r.text}</span>
          <span className="st-bars__track" aria-hidden="true">
            <span className={`st-bars__fill st-bars__fill--${tone}`} style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
          <span className="st-bars__count">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Store Console → Demand near you (docs/11 §5; Change 16, UI-4; audit P1-3; UI-P2 layout): this
 * store's own slice of the brand's insights — where it was the nearest store but could not
 * serve, its fill rate by weekday, its refusals and the brand's suggestions for it. Counts
 * only; never a customer, and never another store's numbers.
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
  const nearest = chartDays.reduce((n, x) => n + x.lookups, 0);
  const had = nearest - chartDays.reduce((n, x) => n + x.no_store, 0);
  const pct = nearest === 0 ? null : Math.round((had / nearest) * 100);
  const missedShoppers = d?.missed.reduce((n, m) => n + m.count, 0) ?? 0;
  const busiest = [...chartDays].sort((a, b) => b.lookups - a.lookups)[0];
  // One row per product (UI-P2 fix): its misses added up, with the weekdays and reasons.
  const bySku = new Map<string, { sku: string; label: string; count: number; weekdays: string[]; reasons: string[] }>();
  for (const m of d?.missed ?? []) {
    const g = bySku.get(m.sku) ?? { sku: m.sku, label: m.label, count: 0, weekdays: [], reasons: [] };
    g.count += m.count;
    if (!g.weekdays.includes(m.weekday)) g.weekdays.push(m.weekday);
    if (!g.reasons.includes(m.reason)) g.reasons.push(m.reason);
    bySku.set(m.sku, g);
  }
  const missed = [...bySku.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const reasonText = (r: string) => REASON[r] ?? r.toLowerCase().replace(/_/g, ' ');
  const daysText = (days: string[]) =>
    days.length === 1
      ? cap(days[0]!)
      : [...days]
          .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
          .map((x) => cap(x).slice(0, 3))
          .join(', ');
  const maxMissed = Math.max(1, ...missed.map((m) => m.count));

  return (
    <ConsoleShell>
      <AskScope days={days} includeHistory={includeHistory} />
      <PageHeader
        title="Demand near you"
        purpose={`What shoppers asked ${me.brand_name} for near ${me.store.store_name}. Counts only — never a customer.`}
        action={
          <AskAction
            label="What are shoppers asking for?"
            question="What are shoppers near me asking for that I don't have?"
          />
        }
      />
      <PeriodControls days={days} onDays={setDays} includeHistory={includeHistory} onHistory={setIncludeHistory}>
        {d && (
          <Tip text={`Weekdays in store time (${d.period.timezone}).`}>
            <Info size={16} aria-label={`Weekdays in store time (${d.period.timezone}).`} />
          </Tip>
        )}
      </PeriodControls>
      {data.error && <ErrorState message={data.error} onRetry={data.reload} />}
      {!d && !data.error && <Skeleton lines={3} />}
      {nothing && (
        <Card>
          <EmptyState>
            Nothing to show yet. Demand appears here as shoppers ask {me.brand_name} for products near your store.
          </EmptyState>
        </Card>
      )}

      {d && !nothing && (
        <>
          <section className="st-demand-summary" aria-label="Demand summary">
            <div className="pf-tile pf-tile--lg pf-tile--ring">
              <RingGauge pct={pct} size={56} />
              <div>
                <span className="pf-tile__label">When you were the nearest store</span>
                <span className="pf-tile__value pf-tile__value--sm">{pct === null ? '—' : `${pct}%`}</span>
                <span className="pf-tile__sub">
                  {nearest === 0 ? 'Not the nearest store yet' : `You had stock ${had} of ${nearest} times`}
                </span>
              </div>
            </div>
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Missed shoppers</span>
              <span className="pf-tile__value pf-tile__value--sm">{missedShoppers}</span>
              <span className="pf-tile__sub">you were nearest but couldn't serve</span>
            </div>
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Busiest day</span>
              <span className="pf-tile__value pf-tile__value--sm">
                {busiest && busiest.lookups > 0 ? cap(busiest.weekday).slice(0, 3) : '—'}
              </span>
              <span className="pf-tile__sub">
                {busiest && busiest.lookups > 0 ? `nearest ${busiest.lookups} times` : 'no lookups yet'}
              </span>
            </div>
          </section>

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
                legend={['You had it', "You couldn't serve"]}
                tooltip={(x) =>
                  `${cap(x.weekday).slice(0, 3)} · nearest ${x.lookups} times · had it ${x.lookups - x.no_store} · missed ${x.no_store}`
                }
              />
            )}
          </Card>

          <div className="st-demand-grid">
            <Card title="Missed demand" description="You were the nearest store, but couldn't serve these shoppers.">
              {missed.length === 0 ? (
                <p className="st-positive">
                  <CheckCircle2 size={18} aria-hidden="true" /> You had what shoppers asked for in this period.
                </p>
              ) : (
                <ol className="st-missed" aria-label="Missed demand">
                  {missed.map((m) => (
                    <li key={m.sku}>
                      <ProductThumb src={null} name={m.label} size={36} />
                      <div className="st-missed__body">
                        <strong>{m.label}</strong>
                        <span className="muted small">
                          {daysText(m.weekdays)} · {m.reasons.map(reasonText).join(', ')}
                        </span>
                        <span className="st-bars__track" aria-hidden="true">
                          <span
                            className="st-bars__fill st-bars__fill--missed"
                            style={{ width: `${(m.count / maxMissed) * 100}%` }}
                          />
                        </span>
                      </div>
                      <span className="st-missed__count">
                        {m.count}
                        <span className="sr-only"> times</span>
                      </span>
                      <AskWhy product={m.label} />
                    </li>
                  ))}
                </ol>
              )}
            </Card>

            <Card title="Holds you refused">
              {refusals.length === 0 ? (
                <p className="st-positive">
                  <CheckCircle2 size={18} aria-hidden="true" /> You didn't refuse any hold in this period.
                </p>
              ) : (
                <BarList
                  label="Holds you refused"
                  tone="missed"
                  rows={refusals.map(([reason, n]) => ({
                    key: reason,
                    text: REFUSAL_LABEL[reason] ?? reason,
                    count: n,
                  }))}
                />
              )}
            </Card>
          </div>

          <Card
            title={`From ${me.brand_name}`}
            description="Suggestions about your store. Shown here only — nothing is sent."
          >
            {d.suggestions.length === 0 ? (
              <EmptyState icon={<Lightbulb size={22} />}>
                No suggestions from {me.brand_name} this period. They appear here when the brand sees something for your
                store.
                <span className="st-suggest-rule small">
                  For example: the same product missed often on one weekday, or holds refused as "not actually in stock"
                  more than once.
                </span>
              </EmptyState>
            ) : (
              <ul className="st-suggestions">
                {d.suggestions.map((s) => (
                  <li key={s.text}>
                    <Lightbulb size={18} aria-hidden="true" />
                    <span>{s.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </ConsoleShell>
  );
}
