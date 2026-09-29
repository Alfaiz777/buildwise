import { describe, expect, it } from 'vitest';
import { isOpenNow, isValidIanaTimezone, parseDayHours, validateStoreHours } from '../src/domain/storeHours.js';
import {
  availableQuantity,
  deriveAvailabilityStatus,
  findEligibleStores,
  haversineDistanceKm,
  type EligibilityCandidate,
} from '../src/domain/storeTruth.js';

const HOURS = {
  timezone: 'Asia/Kolkata',
  monday: '10:00-21:00',
  tuesday: '10:00-21:00',
  wednesday: '10:00-21:00',
  thursday: '10:00-21:00',
  friday: '10:00-21:00',
  saturday: '10:00-22:00',
  sunday: '',
};

describe('store hours (docs/04 §9.2)', () => {
  it.each([
    ['Asia/Kolkata', true],
    ['America/Argentina/Buenos_Aires', true],
    ['UTC', true],
    ['IST', false], // abbreviation — accepted by Node's Intl, rejected by the spec
    ['+05:30', false], // offset — accepted by Node's Intl, rejected by the spec
    ['Asia/Atlantis', false],
    ['', false],
  ])('timezone %s valid: %s', (tz, valid) => {
    expect(isValidIanaTimezone(tz)).toBe(valid);
  });

  it.each([
    ['10:00-21:00', { opens: 600, closes: 1260 }],
    ['', null],
    ['9-5', undefined],
    ['21:00-10:00', undefined], // closing before opening (no overnight hours)
    ['10:00-10:00', undefined],
    ['10:00-24:00', undefined],
  ])('day value "%s"', (value, expected) => {
    expect(parseDayHours(value)).toEqual(expected);
  });

  it('reports the first invalid part of a store_hours object', () => {
    expect(validateStoreHours(HOURS)).toBeNull();
    expect(validateStoreHours({ ...HOURS, timezone: 'IST' })).toEqual({ code: 'INVALID_TIMEZONE' });
    expect(validateStoreHours({ ...HOURS, friday: '9-5' })).toEqual({ code: 'INVALID_HOURS', day: 'friday' });
  });

  // 2026-10-05 is a Monday. Asia/Kolkata is UTC+05:30.
  it.each([
    ['open within hours (Mon 10:00 local)', '2026-10-05T04:30:00Z', true],
    ['closed before opening (Mon 09:59 local)', '2026-10-05T04:29:00Z', false],
    ['closed at exactly closing time (Mon 21:00 local)', '2026-10-05T15:30:00Z', false],
    ['closed on a day with an empty value (Sun 11:30 local)', '2026-10-04T06:00:00Z', false],
    // Server clock in UTC says Monday 20:00 (inside hours), but in the store it is Tue 01:30.
    ['server in UTC while the store is in Asia/Kolkata', '2026-10-05T20:00:00Z', false],
  ])('%s', (_label, instant, open) => {
    expect(isOpenNow(HOURS, new Date(instant))).toBe(open);
  });

  it('treats missing or invalid hours as closed', () => {
    expect(isOpenNow(null, new Date('2026-10-05T06:00:00Z'))).toBe(false);
    expect(isOpenNow({ ...HOURS, timezone: '+05:30' }, new Date('2026-10-05T06:00:00Z'))).toBe(false);
  });
});

describe('distance and availability', () => {
  it('haversine: Bandra ↔ Andheri ≈ 9 km; identical points 0 km', () => {
    const bandra = { latitude: 19.0544, longitude: 72.8267 };
    const andheri = { latitude: 19.1364, longitude: 72.8296 };
    expect(haversineDistanceKm(bandra, andheri)).toBeCloseTo(9.12, 1);
    expect(haversineDistanceKm(bandra, bandra)).toBe(0);
    // Mumbai ↔ Pune is roughly 120 km as the crow flies.
    expect(haversineDistanceKm(bandra, { latitude: 18.5362, longitude: 73.894 })).toBeGreaterThan(110);
  });

  it('available = quantity − reserved, never negative; status derived deterministically', () => {
    expect(availableQuantity(5, 2)).toBe(3);
    expect(availableQuantity(1, 3)).toBe(0);
    expect(deriveAvailabilityStatus(0, 0)).toBe('OUT_OF_STOCK');
    expect(deriveAvailabilityStatus(5, 5)).toBe('OUT_OF_STOCK');
    expect(deriveAvailabilityStatus(3, 0)).toBe('LOW_STOCK');
    expect(deriveAvailabilityStatus(10, 0)).toBe('IN_STOCK');
  });
});

describe('findEligibleStores (every exclusion reason is returned)', () => {
  const origin = { latitude: 19.07, longitude: 72.84 };
  const MONDAY_NOON_IST = new Date('2026-10-05T06:30:00Z');
  const candidate = (
    storeId: string,
    overrides: Partial<EligibilityCandidate['store']> = {},
    inventory: EligibilityCandidate['inventory'] = { quantity: 5, reservedQuantity: 0 },
  ): EligibilityCandidate => ({
    store: {
      storeId,
      storeName: storeId,
      latitude: 19.07,
      longitude: 72.84,
      storeStatus: 'ACTIVE',
      reservationAvailable: true,
      pickupAvailable: true,
      storeHours: HOURS,
      ...overrides,
    },
    inventory,
  });

  it('keeps eligible stores nearest first and explains every excluded store', () => {
    const result = findEligibleStores({
      origin,
      radiusKm: 10,
      now: MONDAY_NOON_IST,
      candidates: [
        candidate('far_ok', { latitude: 19.13, longitude: 72.83 }), // ~6.8 km
        candidate('near_ok', { latitude: 19.071, longitude: 72.841 }),
        candidate('inactive', { storeStatus: 'INACTIVE' }),
        candidate('no_reservations', { reservationAvailable: false }),
        candidate('no_pickup', { pickupAvailable: false }),
        candidate('too_far', { latitude: 18.5362, longitude: 73.894 }),
        candidate('no_coordinates', { latitude: null, longitude: null }),
        candidate('closed', { storeHours: { ...HOURS, monday: '' } }),
        candidate('sold_out', {}, { quantity: 2, reservedQuantity: 2 }),
        candidate('never_stocked', {}, null),
      ],
    });

    expect(result.eligible.map((s) => s.storeId)).toEqual(['near_ok', 'far_ok']);
    expect(result.eligible[0]!.availableQuantity).toBe(5);
    expect(Object.fromEntries(result.excluded.map((s) => [s.storeId, s.reason]))).toEqual({
      inactive: 'INACTIVE',
      no_reservations: 'RESERVATIONS_DISABLED',
      no_pickup: 'RESERVATIONS_DISABLED',
      too_far: 'TOO_FAR',
      no_coordinates: 'TOO_FAR',
      closed: 'CLOSED',
      sold_out: 'OUT_OF_STOCK',
      never_stocked: 'OUT_OF_STOCK',
    });
  });

  it('checks reasons in order: an inactive, distant, sold-out store is reported as INACTIVE', () => {
    const result = findEligibleStores({
      origin,
      radiusKm: 1,
      now: MONDAY_NOON_IST,
      candidates: [candidate('x', { storeStatus: 'INACTIVE', latitude: 28.6, longitude: 77.2 }, null)],
    });
    expect(result.excluded).toEqual([
      { storeId: 'x', storeName: 'x', reason: 'INACTIVE', distanceKm: expect.any(Number) },
    ]);
  });
});
