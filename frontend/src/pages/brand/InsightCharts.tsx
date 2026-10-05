import { useState } from 'react';

/**
 * Hand-built SVG charts for Insights (Change 16, UI-3; audit P2): the same numbers as the
 * tables, drawn. Every chart has a text alternative and a "Show as table" fallback.
 */

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const stepPct = (from: number, to: number) => (from === 0 ? null : Math.round((to / from) * 100));

export interface FunnelStep {
  label: string;
  value: number;
}

/** Horizontal bars, widths relative to the first step, with the step-to-step conversion. */
export function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...steps.map((s) => s.value));
  const rowH = 44;
  const height = steps.length * rowH;
  return (
    <figure className="chart">
      {table ? (
        <FunnelTable steps={steps} />
      ) : (
        <svg
          className="chart__svg"
          viewBox={`0 0 600 ${height}`}
          role="img"
          aria-label={`Journey funnel: ${steps.map((s) => `${s.label} ${s.value}`).join(', ')}`}
          preserveAspectRatio="xMinYMin meet"
        >
          {steps.map((s, i) => {
            const y = i * rowH;
            const w = Math.max(2, (s.value / max) * 320);
            const next = steps[i + 1];
            const pct = next ? stepPct(s.value, next.value) : null;
            return (
              <g key={s.label}>
                <title>{`${s.label}: ${s.value}`}</title>
                <text x="0" y={y + 24} className="chart__label">
                  {s.label}
                </text>
                <rect x="170" y={y + 8} width={w} height="22" rx="4" className="chart__bar" />
                <text x={170 + w + 8} y={y + 24} className="chart__value">
                  {s.value}
                </text>
                {pct !== null && (
                  <text x="590" y={y + 24} textAnchor="end" className="chart__step">
                    → {pct}%
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <figcaption className="chart__caption">
        Each "→ %" is the share that reached the next step.{' '}
        <button type="button" className="ui-link-button" onClick={() => setTable(!table)}>
          {table ? 'Show as chart' : 'Show as table'}
        </button>
      </figcaption>
    </figure>
  );
}

function FunnelTable({ steps }: { steps: FunnelStep[] }) {
  return (
    <table aria-label="Journey funnel">
      <thead>
        <tr>
          <th>Step</th>
          <th>Count</th>
          <th>To next step</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s, i) => {
          const next = steps[i + 1];
          const pct = next ? stepPct(s.value, next.value) : null;
          return (
            <tr key={s.label}>
              <td>{s.label}</td>
              <td>{s.value}</td>
              <td>{pct === null ? '—' : `${pct}%`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface WeekdayBar {
  weekday: string;
  lookups: number;
  no_store: number;
  no_store_pct: number;
}

/**
 * Store lookups per weekday with the share that found no store with stock. The busiest
 * day is outlined; the day the reading names is marked as the problem day.
 */
export function WeekdayChart({
  days,
  problemDay,
  caption,
  keys = ['Store lookups', 'found no store with stock'],
}: {
  days: WeekdayBar[];
  problemDay: string | null;
  caption: string;
  /** Legend for the two bars (UI-4: the Store Console reads them differently). */
  keys?: [string, string];
}) {
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...days.map((d) => d.lookups));
  const peak = [...days].sort((a, b) => b.lookups - a.lookups)[0]?.weekday ?? null;
  const colW = 600 / Math.max(1, days.length);
  const plotH = 160;
  return (
    <figure className="chart">
      {table ? (
        <table aria-label="Demand vs availability by weekday">
          <thead>
            <tr>
              <th>Day</th>
              <th>Store lookups</th>
              <th>No store with stock</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.weekday}>
                <td>{cap(d.weekday)}</td>
                <td>{d.lookups}</td>
                <td>
                  {d.no_store} ({d.no_store_pct}%)
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg
          className="chart__svg"
          viewBox={`0 0 600 ${plotH + 48}`}
          role="img"
          aria-label={`Store lookups by weekday: ${days
            .map((d) => `${cap(d.weekday)} ${d.lookups}, ${d.no_store} with no store`)
            .join('; ')}`}
        >
          {days.map((d, i) => {
            const x = i * colW + colW * 0.2;
            const w = colW * 0.6;
            const h = (d.lookups / max) * plotH;
            const hNo = (d.no_store / max) * plotH;
            const isPeak = d.weekday === peak && d.lookups > 0;
            const isProblem = d.weekday === problemDay;
            return (
              <g key={d.weekday}>
                <title>{`${cap(d.weekday)}: ${d.lookups} lookups, ${d.no_store} found no store (${d.no_store_pct}%)`}</title>
                <rect
                  x={x}
                  y={plotH - h + 16}
                  width={w}
                  height={Math.max(h, 1)}
                  rx="3"
                  className={`chart__col ${isPeak ? 'chart__col--peak' : ''}`}
                />
                <rect x={x} y={plotH - hNo + 16} width={w} height={hNo} rx="3" className="chart__col--danger" />
                <text x={x + w / 2} y={plotH - h + 10} textAnchor="middle" className="chart__value">
                  {d.lookups}
                </text>
                <text x={x + w / 2} y={plotH + 34} textAnchor="middle" className="chart__label">
                  {cap(d.weekday).slice(0, 3)}
                </text>
                {isProblem && (
                  <text x={x + w / 2} y={plotH + 46} textAnchor="middle" className="chart__flag">
                    problem day
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <figcaption className="chart__caption">
        <span className="chart__key chart__key--all" /> {keys[0]} <span className="chart__key chart__key--danger" />{' '}
        {keys[1]}. {caption}{' '}
        <button type="button" className="ui-link-button" onClick={() => setTable(!table)}>
          {table ? 'Show as chart' : 'Show as table'}
        </button>
      </figcaption>
    </figure>
  );
}
