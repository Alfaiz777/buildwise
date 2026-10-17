/**
 * Tiny inline-SVG charts (UI-P1) — no chart library. Decorative: the number they draw is
 * always written next to them, so they are hidden from screen readers.
 */

/** A thin progress bar: `value` of `max`. */
export function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <svg className="ui-progress" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
      <rect className="ui-progress__track" x="0" y="0" width="100" height="6" rx="3" />
      <rect className="ui-progress__fill" x="0" y="0" width={pct} height="6" rx="3" />
    </svg>
  );
}

/** A small ring gauge for a percentage (null = no data: an empty ring). */
export function RingGauge({ pct, size = 40 }: { pct: number | null; size?: number }) {
  const r = 15.5;
  const c = 2 * Math.PI * r;
  const filled = pct === null ? 0 : (Math.min(100, Math.max(0, pct)) / 100) * c;
  const tone = pct === null ? 'none' : pct >= 70 ? 'good' : pct >= 40 ? 'mid' : 'low';
  return (
    <svg className={`ui-ring ui-ring--${tone}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle className="ui-ring__track" cx="20" cy="20" r={r} />
      <circle
        className="ui-ring__fill"
        cx="20"
        cy="20"
        r={r}
        strokeDasharray={`${filled} ${c}`}
        transform="rotate(-90 20 20)"
      />
    </svg>
  );
}

/** "15 → 11": two bars, the second as a share of the first. */
export function MiniFunnel({ from, to }: { from: number; to: number }) {
  const share = from > 0 ? Math.min(1, to / from) : 0;
  return (
    <svg className="ui-funnel" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
      <rect className="ui-funnel__from" x="0" y="0" width="100" height="7" rx="3" />
      <rect className="ui-funnel__to" x="0" y="11" width={share * 100} height="7" rx="3" />
    </svg>
  );
}
