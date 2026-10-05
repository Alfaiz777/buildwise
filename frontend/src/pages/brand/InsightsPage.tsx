import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, Section, useLoad } from '../../components/ConsoleShell';
import { label } from '../../lib/labels';
import { humanize } from './conversationTypes';
import { FunnelChart, WeekdayChart } from './InsightCharts';
import type { BrandStore } from './types';

export interface InsightsResponse {
  period: { days: number; from: string; to: string; timezone: string };
  demo_history: { included: boolean; records: number };
  funnel: {
    intents: number;
    follow_ups_sent: number;
    conversations: number;
    store_recommendations: number;
    reservations: number;
    completed: number;
    outcomes: Record<string, number>;
    /** UI-3: recorded value of purchase outcomes (est.). Absent on older backends. */
    value?: { amount: number; currency: string | null };
  };
  conversion_by_action: {
    action: string;
    intended: string[] | null;
    outcomes: number;
    recorded: Record<string, number>;
    converted: number;
    rate_pct: number | null;
  }[];
  unmet_demand: {
    sku: string;
    label: string;
    area: string;
    weekday: string;
    count: number;
    reasons: Record<string, number>;
  }[];
  weekday: {
    days: {
      weekday: string;
      lookups: number;
      no_store: number;
      no_store_pct: number;
      reservations: number;
      completions: number;
    }[];
    reading: { kind: string; text: string; peak_weekday?: string };
  };
  fill_rate: {
    store_id: string;
    store_name: string;
    weekday: string;
    nearest: number;
    had_stock: number;
    fill_pct: number;
    refusals: Record<string, number>;
  }[];
  suggestions: { rule: string; text: string; evidence: { kind: string; ids: string[] } }[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Purchase types and refusal/exclusion reasons in words. */
const WORDS: Record<string, string> = {
  OFFLINE: 'in-store purchase',
  ONLINE: 'online order',
  ALTERNATIVE: 'alternative product',
  NONE: 'no purchase',
  OUT_OF_STOCK: 'out of stock',
  TOO_FAR: 'too far',
  CLOSED: 'closed',
  INACTIVE: 'store inactive',
  RESERVATIONS_DISABLED: 'reservations off',
  NOT_ACTUALLY_IN_STOCK: 'not actually in stock',
  DAMAGED: 'damaged',
  STORE_CLOSING_EARLY: 'closing early',
  OTHER: 'other',
};
const words = (k: string) => WORDS[k] ?? humanize(k);
const reasons = (r: Record<string, number>) =>
  Object.entries(r)
    .map(([k, v]) => `${words(k)} ${v}`)
    .join(', ') || '—';

/** The stores a suggestion names (by name), so it can link to the store's row in Network. */
export function storesNamedIn(text: string, stores: Pick<BrandStore, 'store_id' | 'store_name'>[]) {
  return stores.filter((s) => s.store_name && text.includes(s.store_name));
}

/**
 * Brand Console → Insights (docs/11 §4; Change 13 F8, Change 16 UI-3). Every number is a
 * count over stored records; the reading and suggestions are fixed rules over those numbers
 * (no AI text). Synthetic demo history is labelled and can be excluded. The funnel and
 * weekday panels are drawn as charts with table fallbacks.
 */
export function InsightsPage() {
  const api = useApi();
  const [days, setDays] = useState<7 | 28>(7);
  const [includeHistory, setIncludeHistory] = useState(true);
  const stores = useLoad(useCallback(() => api.get<{ stores: BrandStore[] }>('/api/brand/stores'), [api]));
  const data = useLoad(
    useCallback(
      () => api.get<InsightsResponse>(`/api/brand/insights?days=${days}&include_history=${includeHistory}`),
      [api, days, includeHistory],
    ),
  );
  const d = data.data;

  return (
    <ConsoleShell>
      <Section title="Insights">
        <div className="filters">
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
          <label className="small">
            <input type="checkbox" checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} />{' '}
            Include synthetic demo history
          </label>
        </div>
        {d && d.demo_history.included && d.demo_history.records > 0 && (
          <p className="notice small" role="note">
            Includes synthetic demo history ({d.demo_history.records} generated records). Untick to see only live
            activity.
          </p>
        )}
        {d && <p className="muted small">Weekdays in store time ({d.period.timezone}).</p>}
        {data.error && <p className="error">{data.error}</p>}
        {!d && !data.error && <p className="muted">Loading…</p>}
      </Section>

      {d && (
        <>
          <Section title="Journey funnel">
            <FunnelChart
              steps={[
                { label: 'Storefront intents', value: d.funnel.intents },
                { label: 'Follow-ups sent', value: d.funnel.follow_ups_sent },
                { label: 'Conversations', value: d.funnel.conversations },
                { label: 'Store offers', value: d.funnel.store_recommendations },
                { label: 'Holds', value: d.funnel.reservations },
                { label: 'Pickups', value: d.funnel.completed },
              ]}
            />
            <p className="small">
              Outcomes:{' '}
              {Object.entries(d.funnel.outcomes)
                .map(([k, v]) => `${words(k)} ${v}`)
                .join(' · ')}
            </p>
          </Section>

          <Section title="Demand vs availability by weekday">
            <p className="reading" data-kind={d.weekday.reading.kind}>
              {d.weekday.reading.text}
            </p>
            <WeekdayChart
              days={d.weekday.days}
              problemDay={
                d.weekday.reading.kind === 'AVAILABILITY_PROBLEM' ? (d.weekday.reading.peak_weekday ?? null) : null
              }
              caption="Weekdays in store time."
            />
            <details className="small">
              <summary>Reservations and pickups by day</summary>
              <table aria-label="Reservations by weekday">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Reservations</th>
                    <th>Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {d.weekday.days.map((day) => (
                    <tr key={day.weekday}>
                      <td>{cap(day.weekday)}</td>
                      <td>{day.reservations}</td>
                      <td>{day.completions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </Section>

          <Section title="Suggested next actions">
            {d.suggestions.length === 0 ? (
              <p className="muted">No suggestions for this period.</p>
            ) : (
              <ul className="suggestions">
                {d.suggestions.map((s) => (
                  <li key={`${s.rule}-${s.evidence.ids[0]}`}>
                    {s.text}
                    <div className="small suggestion-links">
                      Based on {s.evidence.ids.length} {s.evidence.kind === 'EVENTS' ? 'store lookups' : 'reservations'}
                      {storesNamedIn(s.text, stores.data?.stores ?? []).map((store) => (
                        <Link key={store.store_id} to={`/brand/network#store-${store.store_id}`}>
                          Open {store.store_name} →
                        </Link>
                      ))}
                    </div>
                    <details className="small">
                      <summary>Technical details</summary>
                      <span className="mono">{s.evidence.ids.join(', ')}</span>
                    </details>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">Suggestions are shown to you only — nothing is sent to stores.</p>
          </Section>

          <Section title="Unmet local demand">
            {d.unmet_demand.length === 0 ? (
              <p className="muted">Every store lookup in this period found a store with stock.</p>
            ) : (
              <table aria-label="Unmet local demand">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Area</th>
                    <th>Day</th>
                    <th>Lookups</th>
                    <th>Why stores were excluded</th>
                  </tr>
                </thead>
                <tbody>
                  {d.unmet_demand.map((u) => (
                    <tr key={`${u.sku}-${u.area}-${u.weekday}`}>
                      <td>{u.label}</td>
                      <td>{cap(u.area)}</td>
                      <td>{cap(u.weekday)}</td>
                      <td>{u.count}</td>
                      <td className="small">{reasons(u.reasons)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Did the recommendation convert?">
            {d.conversion_by_action.length === 0 ? (
              <p className="muted">No recorded outcomes in this period yet.</p>
            ) : (
              <table aria-label="Conversion by action">
                <thead>
                  <tr>
                    <th>Recommended action</th>
                    <th>Aims for</th>
                    <th>Outcomes</th>
                    <th>Recorded</th>
                    <th>Converted</th>
                  </tr>
                </thead>
                <tbody>
                  {d.conversion_by_action.map((c) => (
                    <tr key={c.action}>
                      <td>{label(c.action)}</td>
                      <td>{c.intended ? c.intended.map(words).join(' or ') : '—'}</td>
                      <td>{c.outcomes}</td>
                      <td className="small">{reasons(c.recorded)}</td>
                      <td>{c.rate_pct === null ? '—' : `${c.converted} (${c.rate_pct}%)`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Fill rate by store">
            {d.fill_rate.length === 0 ? (
              <p className="muted">No store lookups in this period yet.</p>
            ) : (
              <table aria-label="Fill rate by store">
                <thead>
                  <tr>
                    <th>Store</th>
                    <th>Day</th>
                    <th>Was the nearest</th>
                    <th>Had stock</th>
                    <th>Refusals</th>
                  </tr>
                </thead>
                <tbody>
                  {d.fill_rate.map((f) => (
                    <tr key={`${f.store_id}-${f.weekday}`}>
                      <td>{f.store_name}</td>
                      <td>{cap(f.weekday)}</td>
                      <td>{f.nearest}</td>
                      <td>
                        {f.had_stock} ({f.fill_pct}%)
                      </td>
                      <td className="small">{reasons(f.refusals)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </>
      )}
    </ConsoleShell>
  );
}
