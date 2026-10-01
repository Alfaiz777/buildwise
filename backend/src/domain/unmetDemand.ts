/**
 * Unmet local demand (docs/00 §11.8 Change 12, E7): recorded as a STORE_RECOMMENDATION
 * payload when no store is eligible for the variant near the customer. Coarse on purpose:
 * the nearest store's locality or a ~5 km grid cell, never coordinates.
 */
import type { NearbyStoresOutput } from './agentTools.js';
import { gridCell5km } from './locality.js';
import { storeLocalTime } from './storeHours.js';

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
  };
}
