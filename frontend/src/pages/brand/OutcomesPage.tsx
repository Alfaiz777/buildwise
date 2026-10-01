import { useCallback, useState } from 'react';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, Section, useLoad } from '../../components/ConsoleShell';
import { BrandNav } from './BrandNav';
import { humanize } from './conversationTypes';

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
    reading: { kind: string; text: string };
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
const reasons = (r: Record<string, number>) =>
  Object.entries(r)
    .map(([k, v]) => `${humanize(k)} ${v}`)
    .join(', ') || '—';

/**
 * Brand Console → "Outcomes & insights" (docs/11 §4, Change 13 F8). Every number is a count
 * over stored records; the reading and suggestions are fixed rules over those numbers (no
 * AI text). Synthetic demo history is labelled and can be excluded.
 */
export function OutcomesPage() {
  const api = useApi();
  const [days, setDays] = useState<7 | 28>(7);
  const [includeHistory, setIncludeHistory] = useState(true);
  const data = useLoad(
    useCallback(
      () => api.get<InsightsResponse>(`/api/brand/insights?days=${days}&include_history=${includeHistory}`),
      [api, days, includeHistory],
    ),
  );
  const d = data.data;

  return (
    <ConsoleShell>
      <BrandNav />
      <Section title="Outcomes & insights">
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
            <table aria-label="Journey funnel">
              <tbody>
                {(
                  [
                    ['Storefront intents', d.funnel.intents],
                    ['Follow-ups sent', d.funnel.follow_ups_sent],
                    ['Conversations', d.funnel.conversations],
                    ['Store recommendations', d.funnel.store_recommendations],
                    ['Reservations', d.funnel.reservations],
                    ['Completed pickups', d.funnel.completed],
                  ] as const
                ).map(([label, n]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>{n}</td>
                  </tr>
                ))}
                <tr>
                  <td>Outcomes</td>
                  <td>
                    {Object.entries(d.funnel.outcomes)
                      .map(([k, v]) => `${humanize(k)} ${v}`)
                      .join(' · ')}
                  </td>
                </tr>
              </tbody>
            </table>
          </Section>

          <Section title="Demand vs availability by weekday">
            <p className="reading" data-kind={d.weekday.reading.kind}>
              {d.weekday.reading.text}
            </p>
            <table aria-label="Demand vs availability by weekday">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Store lookups</th>
                  <th>No store with stock</th>
                  <th>Reservations</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {d.weekday.days.map((day) => (
                  <tr key={day.weekday}>
                    <td>{cap(day.weekday)}</td>
                    <td>{day.lookups}</td>
                    <td>
                      {day.no_store} ({day.no_store_pct}%)
                    </td>
                    <td>{day.reservations}</td>
                    <td>{day.completions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Suggested next actions">
            {d.suggestions.length === 0 ? (
              <p className="muted">No suggestions for this period.</p>
            ) : (
              <ul className="suggestions">
                {d.suggestions.map((s) => (
                  <li key={`${s.rule}-${s.evidence.ids[0]}`}>
                    {s.text}
                    <details className="small">
                      <summary>
                        Based on {s.evidence.ids.length}{' '}
                        {s.evidence.kind === 'EVENTS' ? 'store lookups' : 'reservations'}
                      </summary>
                      <span className="mono">{s.evidence.ids.join(', ')}</span>
                    </details>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">Display only — nothing is sent.</p>
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
                      <td>{humanize(c.action)}</td>
                      <td>{c.intended ? c.intended.map(humanize).join(' or ') : '—'}</td>
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
