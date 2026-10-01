/**
 * Unmet local demand (docs/00 §11.8 Change 12, E7): recorded as a STORE_RECOMMENDATION
 * payload when no store is eligible for the variant near the customer. Coarse on purpose:
 * the nearest store's locality or a ~5 km grid cell, never coordinates.
 */
import type { NearbyStoresOutput } from './agentTools.js';
import { gridCell5km } from './locality.js';
import { storeLocalTime } from './storeHours.js';

/**
 * The store nearest to the customer in this lookup and whether it could serve (reason null)
 * or why not — for the fill-rate view (Change 13, F8).
 */
export function nearestOf(find: NearbyStoresOutput): {
  nearest_store_id: string | null;
  nearest_reason: string | null;
} {
  const candidates = [
    ...find.eligible.map((s) => ({ id: s.store_id, km: s.distance_km, reason: null as string | null })),
    ...find.excluded
      .filter((x) => x.distance_km !== null)
      .map((x) => ({ id: x.store_id, km: x.distance_km!, reason: x.reason as string })),
  ].sort((a, b) => a.km - b.km);
  return { nearest_store_id: candidates[0]?.id ?? null, nearest_reason: candidates[0]?.reason ?? null };
}

export function unmetDemandPayload(find: NearbyStoresOutput, now: Date) {
  const nearest = find.excluded.find((x) => x.distance_km !== null) ?? null;
  const timezone = nearest?.timezone ?? find.excluded.find((x) => x.timezone)?.timezone ?? 'UTC';
  const local = storeLocalTime(timezone, now);
  return {
    kind: 'UNMET_DEMAND',
    variant_id: find.variant?.variant_id ?? null,
    sku: find.variant?.sku ?? null,
    area: nearest
      ? { type: 'LOCALITY', value: nearest.locality }
      : { type: 'GRID_5KM', value: find.origin_point ? gridCell5km(find.origin_point) : 'unknown' },
    excluded: find.excluded.map((x) => ({ store_id: x.store_id, reason: x.reason })),
    local_weekday: local.weekday,
    local_hour: local.hour,
    timezone,
    ...nearestOf(find),
  };
}
