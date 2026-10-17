import { useEffect, useState } from 'react';

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

/** 0, step, 2·step, 3·step — at most 4 small ticks covering `max`. */
function ticksFor(max: number): number[] {
  const step = Math.max(1, Math.ceil(max / 3));
  return [0, step, step * 2, step * 3];
}

/**
 * Lookups per weekday as stacked bars (UI-P2 redesign, shared by Brand Insights and the Store
 * Console): teal = served (had it), coral = could not serve. The busiest day is solid with a
 * "Busiest" label; the day the reading names is marked "problem day". Hover or focus a day for
 * its numbers; "Show as table" has the same numbers.
 */
/** True at phone width (≤ 768 px), following resizes. */
function useNarrow(): boolean {
  const query = '(max-width: 768px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function WeekdayChart({
  days,
  problemDay,
  caption,
  keys = ['Store lookups', 'found no store with stock'],
  legend = ['Found a store with stock', 'Found no store with stock'],
  tooltip,
}: {
  days: WeekdayBar[];
  problemDay: string | null;
  caption: string;
  /** What the two numbers are (the table's columns and the chart's text alternative). */
  keys?: [string, string];
  /** The legend's two colours: served, could not serve. */
  legend?: [string, string];
  /** The tooltip for one day (default: "Sat · 6 store lookups · 3 found no store with stock"). */
  tooltip?: (d: WeekdayBar) => string;
}) {
  const [table, setTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const ticks = ticksFor(Math.max(1, ...days.map((d) => d.lookups)));
  const top = ticks.at(-1)!;
  const peak = [...days].sort((a, b) => b.lookups - a.lookups)[0];
  const busiest = peak && peak.lookups > 0 ? peak.weekday : null;
  const left = 32;
  const plotTop = 18;
  const plotH = 150;
  // Wide on a desktop card (~200 px tall); narrow on a phone, so the labels stay readable.
  const W = useNarrow() ? 360 : 900;
  const colW = (W - left) / Math.max(1, days.length);
  const barW = 28;
  const y = (v: number) => plotTop + plotH - (v / top) * plotH;
  const tip = (d: WeekdayBar) =>
    tooltip?.(d) ?? `${cap(d.weekday).slice(0, 3)} · ${d.lookups} ${keys[0].toLowerCase()} · ${d.no_store} ${keys[1]}`;
  return (
    <figure className="chart chart--weekday">
      <div className="chart__legend" aria-hidden="true">
        <span>
          <span className="chart__dot chart__dot--served" /> {legend[0]}
        </span>
        <span>
          <span className="chart__dot chart__dot--missed" /> {legend[1]}
        </span>
      </div>
      {table ? (
        <table aria-label="Demand vs availability by weekday">
          <thead>
            <tr>
              <th>Day</th>
              <th>{keys[0]}</th>
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
        <div className="chart__plot">
          <svg
            className="chart__svg"
            viewBox={`0 0 ${W} 236`}
            role="img"
            aria-label={`Store lookups by weekday: ${days
              .map((d) => `${cap(d.weekday)} ${d.lookups}, ${d.no_store} with no store`)
              .join('; ')}`}
          >
            {ticks.map((t) => (
              <g key={t} aria-hidden="true">
                <line x1={left} x2={W} y1={y(t)} y2={y(t)} className="chart__grid" />
                <text x={left - 8} y={y(t) + 4} textAnchor="end" className="chart__tick">
                  {t}
                </text>
              </g>
            ))}
            {days.map((d, i) => {
              const cx = left + i * colW + colW / 2;
              const x = cx - barW / 2;
              const served = Math.max(0, d.lookups - d.no_store);
              const isPeak = d.weekday === busiest;
              const isProblem = d.weekday === problemDay;
              return (
                <g
                  key={d.weekday}
                  className={`chart__day${isPeak ? ' chart__day--peak' : ''}${active === i ? ' is-active' : ''}`}
                  tabIndex={0}
                  aria-label={tip(d)}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                >
                  <title>{tip(d)}</title>
                  {/* Hit area: the whole column, so a thin bar is easy to hover. */}
                  <rect x={left + i * colW} y={plotTop} width={colW} height={plotH} className="chart__hit" />
                  <g className="chart__stack">
                    {served > 0 && (
                      <rect
                        x={x}
                        y={y(served)}
                        width={barW}
                        height={plotTop + plotH - y(served)}
                        rx="6"
                        className="chart__served"
                      />
                    )}
                    {d.no_store > 0 && (
                      <rect
                        x={x}
                        y={y(d.lookups)}
                        width={barW}
                        height={y(served) - y(d.lookups)}
                        rx="6"
                        className="chart__missed"
                      />
                    )}
                  </g>
                  <text x={cx} y={y(d.lookups) - 6} textAnchor="middle" className="chart__value">
                    {d.lookups}
                  </text>
                  <text x={cx} y={plotTop + plotH + 20} textAnchor="middle" className="chart__label">
                    {cap(d.weekday).slice(0, 3)}
                  </text>
                  {isPeak && (
                    <text x={cx} y={plotTop + plotH + 34} textAnchor="middle" className="chart__busiest">
                      Busiest
                    </text>
                  )}
                  {isProblem && (
                    <text x={cx} y={plotTop + plotH + (isPeak ? 48 : 34)} textAnchor="middle" className="chart__flag">
                      problem day
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {active !== null && days[active] && (
            <div
              className="chart__tooltip"
              role="tooltip"
              style={{ left: `${((left + active * colW + colW / 2) / W) * 100}%` }}
            >
              {tip(days[active]!)}
            </div>
          )}
        </div>
      )}
      <figcaption className="chart__caption">
        {caption}{' '}
        <button type="button" className="ui-link-button" onClick={() => setTable(!table)}>
          {table ? 'Show as chart' : 'Show as table'}
        </button>
      </figcaption>
    </figure>
  );
}
