import { describe, expect, it } from 'vitest';
import {
  applyInventoryPlan,
  checkPickupCode,
  decideRetailerTransition,
  decideSimpleTransition,
  PICKUP_CODE_MAX_ATTEMPTS,
  RESERVATION_STATUSES,
  retailerActionsFor,
  type ReservationStatus,
} from '../src/domain/reservationStatus.js';
import {
  confirmedMessage,
  expiredMessage,
  readyMessage,
  refusalApology,
  RESERVATION_TEMPLATES,
  type ReservationFacts,
} from '../src/domain/reservationMessages.js';
import {
  attributionWindowMs,
  converted,
  isJourneyClosed,
  journeyKeyFor,
  parseJourneyKey,
  purchaseTypeFor,
} from '../src/domain/outcomeRules.js';
import { sortQueue } from '../src/application/reservationService.js';

const NOW = '2026-10-07T06:30:00.000Z';
const current = (status: ReservationStatus, extra: Partial<{ pickupCodeAttempts: number }> = {}) => ({
  status,
  quantity: 1,
  pickupCode: '004271',
  pickupCodeAttempts: extra.pickupCodeAttempts ?? 0,
});
const ask = (from: ReservationStatus, to: ReservationStatus, extra: Record<string, unknown> = {}) =>
  decideRetailerTransition(current(from), { to, expectedCurrentStatus: from, ...extra }, NOW);

describe('retailer transitions (docs/04 §15, Change 13 F1)', () => {
  const ALLOWED: [ReservationStatus, ReservationStatus][] = [
    ['PENDING', 'CONFIRMED'],
    ['CONFIRMED', 'READY'],
    ['READY', 'CUSTOMER_ARRIVED'],
    ['CUSTOMER_ARRIVED', 'COMPLETED'],
    ['PENDING', 'CANCELLED'],
    ['CONFIRMED', 'CANCELLED'],
    ['READY', 'CANCELLED'],
  ];

  it('every allowed store transition applies, with its timestamp', () => {
    for (const [from, to] of ALLOWED) {
      const d = ask(from, to, { pickupCode: '004271', cancelReason: 'DAMAGED' });
      expect(d, `${from} → ${to}`).toMatchObject({ kind: 'APPLY', plan: { to } });
    }
    expect(ask('PENDING', 'CONFIRMED')).toMatchObject({ plan: { patch: { confirmedAt: NOW } } });
    expect(ask('CUSTOMER_ARRIVED', 'COMPLETED', { pickupCode: '004271' })).toMatchObject({
      plan: { patch: { completedAt: NOW } },
    });
  });

  it('every other pair is INVALID_TRANSITION (incl. READY → COMPLETED and store-side EXPIRED)', () => {
    const allowed = new Set(ALLOWED.map(([a, b]) => `${a}>${b}`));
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        if (allowed.has(`${from}>${to}`)) continue;
        expect(ask(from, to, { pickupCode: '004271', cancelReason: 'DAMAGED' }), `${from} → ${to}`).toEqual({
          kind: 'REJECT',
          reason: 'INVALID_TRANSITION',
        });
      }
    }
  });

  it('optimistic concurrency: a different current status → STALE_STATUS before anything else', () => {
    expect(
      decideRetailerTransition(current('CONFIRMED'), { to: 'CONFIRMED', expectedCurrentStatus: 'PENDING' }, NOW),
    ).toEqual({ kind: 'REJECT', reason: 'STALE_STATUS' });
  });

  it('inventory effect of each transition, always 0 ≤ reserved ≤ quantity', () => {
    const inv = { quantity: 5, reservedQuantity: 2 };
    const effectOf = (from: ReservationStatus, to: ReservationStatus, extra = {}) => {
      const d = ask(from, to, { pickupCode: '004271', cancelReason: 'DAMAGED', ...extra });
      if (d.kind !== 'APPLY') throw new Error('expected APPLY');
      return applyInventoryPlan(inv, d.plan);
    };
    expect(effectOf('PENDING', 'CONFIRMED')).toEqual({ quantity: 5, reservedQuantity: 2 });
    expect(effectOf('CONFIRMED', 'READY')).toEqual({ quantity: 5, reservedQuantity: 2 });
    expect(effectOf('READY', 'CUSTOMER_ARRIVED')).toEqual({ quantity: 5, reservedQuantity: 2 });
    expect(effectOf('CUSTOMER_ARRIVED', 'COMPLETED')).toEqual({ quantity: 4, reservedQuantity: 1 });
    expect(effectOf('READY', 'CANCELLED')).toEqual({ quantity: 5, reservedQuantity: 1 });
    // NOT_ACTUALLY_IN_STOCK: after the release, quantity = remaining reserved → available 0.
    expect(effectOf('READY', 'CANCELLED', { cancelReason: 'NOT_ACTUALLY_IN_STOCK' })).toEqual({
      quantity: 1,
      reservedQuantity: 1,
    });
    const expired = decideSimpleTransition({ status: 'PENDING', quantity: 1 }, 'EXPIRED', {});
    if (expired.kind !== 'APPLY') throw new Error('expected APPLY');
    expect(applyInventoryPlan({ quantity: 1, reservedQuantity: 0 }, expired.plan)).toEqual({
      quantity: 1,
      reservedQuantity: 0,
    }); // clamped, never negative
  });

  it('refusal needs a reason; OTHER keeps a trimmed internal note ≤ 140; other reasons drop the note', () => {
    expect(ask('PENDING', 'CANCELLED')).toEqual({ kind: 'REJECT', reason: 'REASON_REQUIRED' });
    const other = ask('PENDING', 'CANCELLED', { cancelReason: 'OTHER', cancelNote: `  ${'x'.repeat(200)} ` });
    expect(other).toMatchObject({ plan: { patch: { cancelledBy: 'RETAILER', cancelReason: 'OTHER' } } });
    if (other.kind === 'APPLY') expect(String(other.plan.patch.cancelNote)).toHaveLength(140);
    expect(ask('PENDING', 'CANCELLED', { cancelReason: 'DAMAGED', cancelNote: 'secret' })).toMatchObject({
      plan: { patch: { cancelNote: null }, correctQuantityToReserved: false },
    });
    expect(ask('PENDING', 'CANCELLED', { cancelReason: 'NOT_ACTUALLY_IN_STOCK' })).toMatchObject({
      plan: { correctQuantityToReserved: true },
    });
  });
});

describe('pickup code at completion (Change 13, F2)', () => {
  it('match → APPLY; mismatch → +1 attempt; locked from the 5th wrong attempt', () => {
    expect(checkPickupCode('004271', ' 004 271 ', 0)).toBe('OK');
    expect(checkPickupCode('004271', '004270', 0)).toBe('MISMATCH');
    expect(checkPickupCode('004271', '004271', PICKUP_CODE_MAX_ATTEMPTS)).toBe('LOCKED');
    expect(ask('CUSTOMER_ARRIVED', 'COMPLETED', { pickupCode: '111111' })).toEqual({
      kind: 'REJECT',
      reason: 'PICKUP_CODE_MISMATCH',
      pickupCodeAttempts: 1,
    });
    expect(
      decideRetailerTransition(
        current('CUSTOMER_ARRIVED', { pickupCodeAttempts: 5 }),
        { to: 'COMPLETED', expectedCurrentStatus: 'CUSTOMER_ARRIVED', pickupCode: '004271' },
        NOW,
      ),
    ).toEqual({ kind: 'REJECT', reason: 'PICKUP_CODE_LOCKED' });
  });

  it('queue actions per status; Complete is hidden once the code is locked', () => {
    expect(retailerActionsFor('PENDING')).toEqual(['CONFIRMED', 'CANCELLED']);
    expect(retailerActionsFor('READY')).toEqual(['CUSTOMER_ARRIVED', 'CANCELLED']);
    expect(retailerActionsFor('CUSTOMER_ARRIVED')).toEqual(['COMPLETED']);
    expect(retailerActionsFor('CUSTOMER_ARRIVED', true)).toEqual([]);
    expect(retailerActionsFor('COMPLETED')).toEqual([]);
  });

  it('queue order: PENDING first, then the soonest expiry', () => {
    const rows = [
      { id: 'a', status: 'CONFIRMED' as const, expiresAt: '2026-10-07T07:00:00Z' },
      { id: 'b', status: 'PENDING' as const, expiresAt: '2026-10-07T09:00:00Z' },
      { id: 'c', status: 'READY' as const, expiresAt: '2026-10-07T06:45:00Z' },
      { id: 'd', status: 'PENDING' as const, expiresAt: '2026-10-07T08:00:00Z' },
    ];
    expect(sortQueue(rows).map((r) => r.id)).toEqual(['d', 'b', 'c', 'a']);
  });
});

describe('notification builders (Change 13, F4)', () => {
  const facts: ReservationFacts = {
    reservationId: 'res_1',
    storeName: 'Andheri Store',
    storeTimezone: 'Asia/Kolkata',
    latitude: 19.1364,
    longitude: 72.8296,
    productLabel: 'Vitamin C Glow Serum 30 ml',
    quantity: 1,
    pickupCode: '004271',
    expiresAt: '2026-10-07T08:30:00.000Z',
    variantId: 'var_2001',
  };

  it('verified facts only: store, product, code, hold time in store time, maps link', () => {
    expect(confirmedMessage(facts, new Date(NOW))).toEqual({
      message_type: 'INTERACTIVE',
      text: 'Andheri Store has confirmed your reservation for Vitamin C Glow Serum 30 ml. Pickup code 004271, held until 14:00 (store time).',
      options: [{ option_id: 'cancel:res_1', label: 'Cancel reservation' }],
    });
    expect(readyMessage(facts).text).toBe(
      'Your Vitamin C Glow Serum 30 ml is ready at Andheri Store. Show code 004271. Directions: https://www.google.com/maps/search/?api=1&query=19.1364,72.8296',
    );
    expect(expiredMessage(facts)).toMatchObject({
      text: 'Your hold at Andheri Store for Vitamin C Glow Serum 30 ml has expired.',
      options: [{ option_id: 'recheck:var_2001', label: 'Check stores again' }],
    });
  });

  it('a refusal apologises without blame and never carries a reason or internal note', () => {
    const text = refusalApology(facts);
    expect(text).toBe("Sorry — Andheri Store can't fulfil your reservation for Vitamin C Glow Serum 30 ml after all.");
    expect(text).not.toMatch(/stock|damaged|closing|note|you (did|failed)/i);
  });

  it('named templates exist for every update', () => {
    expect(Object.values(RESERVATION_TEMPLATES)).toEqual([
      'qwikspot_reservation_confirmed_v1',
      'qwikspot_reservation_ready_v1',
      'qwikspot_reservation_refused_v1',
      'qwikspot_reservation_expired_v1',
    ]);
  });
});

describe('outcome rules (docs/04 §16, Change 13 F5)', () => {
  it('journey keys and purchase types', () => {
    expect(journeyKeyFor({ intentId: 'int_1', conversationId: 'conv_1' })).toBe('int:int_1');
    expect(journeyKeyFor({ intentId: null, conversationId: 'conv_1' })).toBe('conv:conv_1');
    expect(parseJourneyKey('conv:conv_1')).toEqual({ intentId: null, conversationId: 'conv_1' });
    expect(purchaseTypeFor('STORE', 'var_1', 'var_1')).toBe('OFFLINE');
    expect(purchaseTypeFor('STORE', 'var_1', 'var_2')).toBe('ALTERNATIVE');
    expect(purchaseTypeFor('ONLINE', null, 'var_2')).toBe('ONLINE');
    expect(purchaseTypeFor('ONLINE', 'var_1', 'var_2')).toBe('ALTERNATIVE');
  });

  it('NONE only after the window and never while a reservation is active', () => {
    const windowMs = 10 * 60_000;
    const at = (m: number) => new Date(Date.parse(NOW) + m * 60_000);
    expect(isJourneyClosed({ lastActivityAt: NOW, windowMs, now: at(9), hasActiveReservation: false })).toBe(false);
    expect(isJourneyClosed({ lastActivityAt: NOW, windowMs, now: at(10), hasActiveReservation: false })).toBe(true);
    expect(isJourneyClosed({ lastActivityAt: NOW, windowMs, now: at(60), hasActiveReservation: true })).toBe(false);
  });

  it('attribution window: minutes override, days, default 7 days', () => {
    expect(attributionWindowMs({ outcome_policy: { attribution_window_minutes: 10 } })).toBe(600_000);
    expect(attributionWindowMs({ outcome_policy: { attribution_window_days: 2 } })).toBe(2 * 86_400_000);
    expect(attributionWindowMs({})).toBe(7 * 86_400_000);
  });

  it('"converted" compares the recorded purchase type with the action’s intended one (docs/04 §16.1)', () => {
    expect(converted('STORE_RESERVATION', 'OFFLINE')).toBe(true);
    expect(converted('STORE_RESERVATION', 'ONLINE')).toBe(false);
    expect(converted('ONLINE_PURCHASE', 'ONLINE')).toBe(true);
    expect(converted('ALTERNATIVE_PRODUCT', 'ALTERNATIVE')).toBe(true);
    expect(converted('NO_ACTION', 'ONLINE')).toBe(false);
  });
});
