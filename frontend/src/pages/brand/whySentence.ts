import { EXCLUSION_TEXT, type Recommendation } from './conversationTypes';

/**
 * "Why Qwikspot did this" in one plain sentence (Change 16, UI-3; audit P0-3), built only
 * from the decision's stored trace: store names, distances and reasons in words. It never
 * adds a fact the trace does not hold.
 */

type StoreFact = { store_id: string; store_name: string; distance_km: number | null; reason?: string };

const km = (d: number | null) => (d === null ? '' : ` (${Math.round(d * 10) / 10} km)`);

/** "A", "A and B", "A, B and C". */
export function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** One entry per store: the decision's variant if known, else the first seen. */
function uniqueStores<T extends { store_id: string; variant_id: string }>(list: T[], variantId: string | null): T[] {
  const preferred = variantId ? list.filter((s) => s.variant_id === variantId) : [];
  const source = preferred.length ? preferred : list;
  const seen = new Set<string>();
  return source.filter((s) => (seen.has(s.store_id) ? false : (seen.add(s.store_id), true)));
}

const excludedPhrase = (s: StoreFact) =>
  `${s.store_name}${km(s.distance_km)} ${s.reason === 'TOO_FAR' ? 'is too far' : `is ${EXCLUSION_TEXT[s.reason ?? ''] ?? 'not available'}`}`;

const BLOCKED: Record<string, (store: string | null) => string> = {
  OUT_OF_STOCK: (s) => `Didn't hold${s ? ` at ${s}` : ''}: the stock check just before holding found none left.`,
  STORE_CLOSED: (s) => `Didn't hold${s ? ` at ${s}` : ''}: the store is closed right now.`,
  NOT_ELIGIBLE: (s) =>
    `Didn't hold${s ? ` at ${s}` : ''}: the store or request isn't eligible (too far, reservations off or over the limit).`,
  SCOPE_VIOLATION: () => "Refused: the request was outside this customer's or brand's scope.",
  AMBIGUOUS: () => "Didn't hold yet: it wasn't clear which store the customer meant, so they were asked first.",
};

const SIMPLE: Record<string, string> = {
  EDUCATE: "Answered from the product's catalogue information.",
  COMPARE: 'Compared it with its verified alternative.',
  ONLINE_PURCHASE: 'Sent the online store link.',
  ALTERNATIVE_PRODUCT: 'Suggested a verified alternative product.',
  HUMAN_HANDOFF: 'Handed the conversation to your team.',
  NO_ACTION: 'Asked the customer what they need.',
};

export function whySentence(r: Recommendation): string {
  const t = r.trace;
  const fallback =
    r.decision_source !== 'AGENT' && t?.fallback_reason
      ? " (The assistant couldn't decide, so a safe fixed reply was sent.)"
      : '';
  const variantId = r.target_variant_id ?? null;
  const eligible: StoreFact[] = t ? uniqueStores(t.eligible, variantId) : [];
  const excluded: StoreFact[] = t ? uniqueStores(t.excluded, variantId) : [];
  // The offered store: the decision's target, the hold's store, or the only eligible store.
  const targetId =
    r.target_store_id ?? r.reservation?.store_id ?? (eligible.length === 1 ? eligible[0]!.store_id : null);
  const target =
    eligible.find((s) => s.store_id === targetId) ??
    excluded.find((s) => s.store_id === targetId) ??
    (targetId && r.reservation
      ? { store_id: targetId, store_name: r.reservation.store_name, distance_km: null }
      : null);

  const blocked = r.guardrail_status === 'BLOCKED' || t?.guardrail.status === 'BLOCKED';
  if (blocked) {
    const code = t?.guardrail.reason_code ?? r.guardrail_reason ?? '';
    const text = BLOCKED[code]?.(target?.store_name ?? null) ?? "Didn't act: a safety check blocked it.";
    return text + fallback;
  }

  const isStore = r.action === 'STORE_DISCOVERY' || r.action === 'STORE_RESERVATION';
  if (isStore || (eligible.length === 0 && excluded.length > 0)) {
    // A hold's own trace may carry no store lists (they belong to the offer before it).
    if (target && (eligible.some((s) => s.store_id === target.store_id) || r.reservation)) {
      // Only a nearer store that was excluded explains the choice; a farther one is cited
      // alongside it (up to two in all), never on its own.
      const sorted = excluded
        .filter((s) => s.store_id !== target.store_id)
        .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
      const nearer = sorted.some(
        (s) => s.distance_km !== null && target.distance_km !== null && s.distance_km < target.distance_km,
      );
      const others = nearer ? sorted.slice(0, 2) : [];
      const verb = r.reservation ? `Held ${r.reservation.quantity ?? 1} at` : 'Offered';
      const because = others.length
        ? ` because ${joinWords(others.map(excludedPhrase))}`
        : eligible.length === 0
          ? ''
          : eligible.length === 1
            ? ', the only nearby store with stock'
            : eligible.every((s) => (s.distance_km ?? Infinity) >= (target.distance_km ?? Infinity))
              ? ', the nearest store with stock'
              : '';
      const checked = r.reservation ? ' Stock was re-checked just before holding.' : '';
      return `${verb} ${target.store_name}${km(target.distance_km)}${because}.${checked}${fallback}`;
    }
    if (eligible.length === 0 && excluded.length > 0) {
      const nearest = [...excluded]
        .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity))
        .slice(0, 2);
      const next = r.action === 'ONLINE_PURCHASE' ? ' Offered to buy online instead.' : '';
      return `No store could take this today: ${joinWords(nearest.map(excludedPhrase))}.${next}${fallback}`;
    }
    if (eligible.length > 1 && r.action === 'STORE_DISCOVERY') {
      return `Listed ${eligible.length} stores with stock nearby: ${joinWords(
        eligible.slice(0, 3).map((s) => `${s.store_name}${km(s.distance_km)}`),
      )}.${fallback}`;
    }
  }
  return (SIMPLE[r.action] ?? r.rationale_summary) + fallback;
}

/** The guardrail result as a short badge in words. */
export function safetyLabel(r: Recommendation): { text: string; tone: 'success' | 'warning' | 'neutral' } {
  const t = r.trace;
  if (r.guardrail_status === 'BLOCKED' || t?.guardrail.status === 'BLOCKED') {
    const code = t?.guardrail.reason_code ?? r.guardrail_reason ?? '';
    const words: Record<string, string> = {
      OUT_OF_STOCK: 'Blocked: out of stock',
      STORE_CLOSED: 'Blocked: store closed',
      NOT_ELIGIBLE: 'Blocked: not eligible',
      SCOPE_VIOLATION: 'Blocked: out of scope',
      AMBIGUOUS: 'Asked first',
    };
    return { text: words[code] ?? 'Blocked', tone: 'warning' };
  }
  if (t?.guardrail.checked) return { text: 'Safety check passed', tone: 'success' };
  return { text: 'Nothing to check', tone: 'neutral' };
}
