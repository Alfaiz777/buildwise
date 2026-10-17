import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { stepPct } from './InsightCharts';
import type { InsightsResponse } from './InsightsPage';

/**
 * The shopper journey (UI-P3): the product's story as one horizontal flow — intents caught →
 * conversations → stores recommended → holds → picked up, with online orders as a branch.
 * Rounded blocks sized by their count, joined by tapered bands that show how many went on.
 * Every number is a field of GET /api/brand/insights (the same as the Overview tiles); each
 * stage opens the page that lists it. On a phone the flow turns vertical.
 */
export interface JourneyStage {
  key: string;
  label: string;
  value: number;
  /** Where the stage's records are listed (with a filter when there is one). */
  to: string;
  /** What the link opens, for screen readers ("Conversations — Intents"). */
  opens: string;
}

export function journeyStages(f: InsightsResponse['funnel']): { stages: JourneyStage[]; online: JourneyStage } {
  return {
    stages: [
      {
        key: 'intents',
        label: 'Intents caught',
        value: f.intents,
        to: '/brand/conversations?tab=intents',
        opens: 'Conversations, Intents tab',
      },
      {
        key: 'conversations',
        label: 'Conversations',
        value: f.conversations,
        to: '/brand/conversations',
        opens: 'Conversations',
      },
      {
        key: 'recommended',
        label: 'Stores recommended',
        value: f.store_recommendations,
        to: '/brand/insights#funnel',
        opens: 'Insights, journey funnel',
      },
      {
        key: 'holds',
        label: 'Holds',
        value: f.reservations,
        to: '/brand/reservations',
        opens: 'Reservations',
      },
      {
        key: 'pickups',
        label: 'Picked up',
        value: f.completed,
        to: '/brand/reservations?filter=picked_up',
        opens: 'Reservations, picked up',
      },
    ],
    online: {
      key: 'online',
      label: 'Online orders',
      value: (f.outcomes.ONLINE ?? 0) + (f.outcomes.ALTERNATIVE ?? 0),
      to: '/brand/insights#funnel',
      opens: 'Insights, journey funnel',
    },
  };
}

/** Block heights (px, desktop): a floor so a small stage stays readable, plus its share. */
const MIN_H = 56;
const SPAN_H = 88;
const H = MIN_H + SPAN_H;
const height = (value: number, max: number) => MIN_H + (max === 0 ? 0 : (value / max) * SPAN_H);

export function JourneyFunnel({ funnel, large = false }: { funnel: InsightsResponse['funnel']; large?: boolean }) {
  const { stages, online } = journeyStages(funnel);
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className={`journey${large ? ' journey--large' : ''}`}>
      <ol className="journey__flow" aria-label="Shopper journey">
        {stages.map((s, i) => {
          const next = stages[i + 1];
          // A share only when the next stage is a part of this one (e.g. 41 intents → 1 new
          // conversation); when it is larger (36 recommendations from 1 new conversation), no %.
          const pct = next && next.value <= s.value ? stepPct(s.value, next.value) : null;
          const hl = height(s.value, max);
          const hr = next ? height(next.value, max) : 0;
          return (
            <li key={s.key} className="journey__stage" style={{ ['--h' as string]: `${hl}px` }}>
              <Link
                to={s.to}
                className="journey__block"
                aria-label={`${s.label}: ${s.value}. Open ${s.opens}`}
                style={{ ['--size' as string]: String(max === 0 ? 0 : s.value / max) }}
              >
                <span className="journey__value">{s.value}</span>
                <span className="journey__label">{s.label}</span>
              </Link>
              {next && (
                <span className="journey__band">
                  <svg viewBox={`0 0 48 ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
                    <polygon
                      points={`0,${(H - hl) / 2} 48,${(H - hr) / 2} 48,${(H + hr) / 2} 0,${(H + hl) / 2}`}
                      className="journey__band-shape"
                    />
                  </svg>
                  {pct !== null && (
                    <span className="journey__pct">
                      {pct}%<span className="sr-only"> went on to {next.label.toLowerCase()}</span>
                    </span>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="journey__branch">
        <span className="journey__elbow" aria-hidden="true" />
        <Link
          to={online.to}
          className="journey__online"
          aria-label={`${online.label}: ${online.value}. Open ${online.opens}`}
        >
          <span className="journey__value">{online.value}</span>
          <span className="journey__label">
            {online.label} <span className="muted">· from chat links</span>
          </span>
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
