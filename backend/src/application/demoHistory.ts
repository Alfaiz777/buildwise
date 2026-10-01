/**
 * Synthetic demo history (docs/00 §11.8 Change 13, F9; docs/07 §19: synthetic data only).
 * A PURE, deterministic generator: a fixed seed and `now` always give the same 4 weeks of
 * journeys. It builds every record with the live domain functions (intent classification,
 * store eligibility, unmet-demand payloads, the retailer transition rules, outcome rules)
 * and the live record types; `seed:demo` writes them through the repositories and marks
 * each document `demo_history: true`. Customers are referenced as `hist:<ref>` placeholders
 * that the writer replaces with the IDs it creates.
 *
 * Pattern (visible on the Outcomes screen): weekend lookups for Serum 30 ml are about
 * double; Andheri runs out of it on most Saturdays while Bandra does not; Serum 50 ml is
 * asked for again and again near Andheri, where no store stocks it.
 */
import type { NearbyStoresOutput } from '../domain/agentTools.js';
import { applyWebEvent, type IntentClassification } from '../domain/intentClassification.js';
import { primaryLocality } from '../domain/locality.js';
import { journeyKeyFor, purchaseTypeFor, type PurchaseType } from '../domain/outcomeRules.js';
import {
  decideRetailerTransition,
  generatePickupCode,
  type RefusalReason,
  type ReservationStatus,
} from '../domain/reservationStatus.js';
import { storeLocalTime, type StoreHours } from '../domain/storeHours.js';
import { findEligibleStores, type GeoPoint } from '../domain/storeTruth.js';
import { nearestOf, unmetDemandPayload } from '../domain/unmetDemand.js';
import { hashedId } from '../lib/ids.js';
import type {
  CommerceEventRecord,
  ConversationRecord,
  IntentRecord,
  RecommendationRecord,
} from '../ports/conversationRepositories.js';
import type { OutcomeRecord } from '../ports/outcomes.js';
import type { ReservationRecord } from '../ports/reservations.js';
import { intentIdFor } from './intentService.js';
import { OutcomeService } from './outcomeService.js';
import { ReservationService } from './reservationService.js';

export interface HistoryStore {
  storeId: string;
  storeName: string;
  city: string;
  address: string | null;
  retailerId: string | null;
  latitude: number;
  longitude: number;
  storeHours: StoreHours;
}

export interface HistoryVariant {
  variantId: string;
  productId: string;
  productTitle: string;
  title: string;
  sku: string;
  canonicalSku: string;
  price: number;
  currency: string;
}

export interface DemoHistoryInput {
  seed: number;
  now: Date;
  brandId: string;
  days: number;
  stores: HistoryStore[];
  /** [Serum 30 ml, Serum 50 ml] — the SKUs the pattern is about. */
  serum30: HistoryVariant;
  serum50: HistoryVariant;
}

export interface DemoHistory {
  customerRefs: string[];
  intents: IntentRecord[];
  conversations: ConversationRecord[];
  recommendations: RecommendationRecord[];
  events: CommerceEventRecord[];
  reservations: ReservationRecord[];
  outcomes: OutcomeRecord[];
  /** Hashes of attribution refs used by the synthetic attributed orders. */
  attributionRefs: {
    refHash: string;
    intentId: string;
    conversationId: string;
    recommendationId: string;
    createdAt: string;
    expiresAt: string;
  }[];
}

/** mulberry32: a tiny deterministic PRNG. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const ANDHERI_AREA: GeoPoint = { latitude: 19.14, longitude: 72.86 };
const BANDRA_AREA: GeoPoint = { latitude: 19.06, longitude: 72.83 };
const CUSTOMERS = 14;
const REFUSALS: RefusalReason[] = ['NOT_ACTUALLY_IN_STOCK', 'DAMAGED', 'STORE_CLOSING_EARLY'];

export function generateDemoHistory(input: DemoHistoryInput): DemoHistory {
  const rnd = prng(input.seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const out: DemoHistory = {
    customerRefs: Array.from({ length: CUSTOMERS }, (_, i) => `hist_${String(i + 1).padStart(2, '0')}`),
    intents: [],
    conversations: [],
    recommendations: [],
    events: [],
    reservations: [],
    outcomes: [],
    attributionRefs: [],
  };
  const brandId = input.brandId;
  const tz = input.stores[0]?.storeHours.timezone ?? 'UTC';
  const conversationOf = new Map<string, ConversationRecord>();
  const andheri = input.stores.find((s) => /andheri/i.test(s.storeName));
  let seq = 0;

  const event = (
    at: string,
    eventType: CommerceEventRecord['eventType'],
    customerId: string | null,
    entityReference: string | null,
    payload: CommerceEventRecord['payload'],
    key: string,
  ) => {
    const idempotencyKey = `HISTORY:${eventType}:${key}`;
    out.events.push({
      eventId: hashedId('evt', `${brandId}:${idempotencyKey}`),
      brandId,
      customerId,
      webSessionId: null,
      eventType,
      source: 'BUILDWISE',
      entityReference,
      payload,
      timestamp: at,
      idempotencyKey,
    });
  };

  for (let daysAgo = input.days; daysAgo >= 1; daysAgo--) {
    // UTC midnight of that day; lookups happen 05:00–14:00 UTC (10:30–19:30 in Mumbai), so the
    // store-time weekday of the whole day is the weekday at 10:00 UTC.
    const raw = input.now.getTime() - daysAgo * DAY;
    const dayBase = raw - (raw % DAY);
    const weekday = storeLocalTime(tz, new Date(dayBase + 10 * HOUR)).weekday;
    const weekend = weekday === 'saturday' || weekday === 'sunday';
    // Andheri's Serum 30 ml stock that day: out on most Saturdays.
    const andheriOut = weekday === 'saturday' && rnd() < 0.8;
    const lookups: { variant: HistoryVariant; origin: GeoPoint }[] = [];
    for (let i = 0; i < (weekend ? between(9, 12) : between(4, 6)); i++) {
      lookups.push({ variant: input.serum30, origin: rnd() < 0.6 ? ANDHERI_AREA : BANDRA_AREA });
    }
    if (rnd() < 0.7) lookups.push({ variant: input.serum50, origin: ANDHERI_AREA });

    for (const lookup of lookups) {
      seq++;
      // A time inside store hours (10:30–19:30 store time; IST has no daylight saving).
      const at = new Date(dayBase + 5 * HOUR + between(0, 9 * 60) * 60_000);
      const iso = at.toISOString();
      const ref = pick(out.customerRefs);
      const customerId = `hist:${ref}`;
      const webSessionId = `ws_hist_${input.seed}_${seq}`;
      const intentId = intentIdFor(brandId, webSessionId);

      // Intent: the same classifier as the storefront path (view → "Need it today?").
      let c: IntentClassification | null = null;
      const productEvent = {
        productId: lookup.variant.productId,
        variantId: lookup.variant.variantId,
        matchedCategory: null,
      };
      c = applyWebEvent(c, {
        type: 'PRODUCT_DETAIL_VIEW',
        ...productEvent,
        entry: null,
        at: new Date(at.getTime() - 4 * 60_000).toISOString(),
      });
      c = applyWebEvent(c, {
        type: 'WHATSAPP_CLICK',
        ...productEvent,
        entry: 'STORE_NEED',
        at: new Date(at.getTime() - 2 * 60_000).toISOString(),
      });
      const followUpSent = rnd() < 0.25;
      out.intents.push({
        intentId,
        brandId,
        customerId,
        webSessionId,
        visitorHash: null,
        source: 'WEBSITE',
        stage: c.stage,
        strength: c.strength,
        type: c.type,
        confidence: 0.8,
        productId: c.productId,
        variantId: c.variantId,
        matchedCategory: c.matchedCategory,
        signals: c.signals,
        lastEvent: c.lastEvent,
        lastEventAt: c.lastEventAt,
        eventCount: c.eventCount,
        detectedAt: new Date(at.getTime() - 4 * 60_000).toISOString(),
        updatedAt: iso,
        status: 'ABANDONED',
        tokenConsumedAt: new Date(at.getTime() - 60_000).toISOString(),
        followUp: followUpSent
          ? {
              decision: 'FOLLOW_UP_ELIGIBLE',
              reason: 'ELIGIBLE',
              evaluatedAt: new Date(at.getTime() - 3 * 60_000).toISOString(),
              dueAt: new Date(at.getTime() - 2 * 60_000).toISOString(),
              priority: 'NORMAL',
              status: 'REPLIED',
              messageKind: 'TEMPLATE',
              templateName: 'buildwise_store_nearby_v1',
              sentMessageId: null,
              conversationId: null,
              claimedAt: new Date(at.getTime() - 2 * 60_000).toISOString(),
              sentAt: new Date(at.getTime() - 90_000).toISOString(),
            }
          : null,
        processedEventIds: [],
      });

      let conversation = conversationOf.get(ref);
      if (!conversation) {
        conversation = {
          conversationId: hashedId('conv', `${brandId}:history:${ref}`, 16),
          brandId,
          customerId,
          channel: 'SIMULATOR',
          status: 'OPEN',
          currentIntentId: intentId,
          startedAt: iso,
          updatedAt: iso,
          lastInboundAt: iso,
          lastMessageAt: iso,
          humanHandoff: false,
          aiWindow: { windowStart: null, count: 0, noticeSent: false },
          pendingProposal: null,
          handoffAt: null,
        };
        conversationOf.set(ref, conversation);
        out.conversations.push(conversation);
      }
      Object.assign(conversation, {
        currentIntentId: intentId,
        updatedAt: iso,
        lastInboundAt: iso,
        lastMessageAt: iso,
      });

      // Store lookup: the live eligibility rules on that day's synthetic stock.
      const stockOf = (storeId: string) => {
        if (lookup.variant === input.serum50) return 0;
        if (storeId === andheri?.storeId) return andheriOut ? 0 : 5;
        return /powai/i.test(input.stores.find((s) => s.storeId === storeId)?.storeName ?? '') ? 0 : 3;
      };
      const result = findEligibleStores({
        origin: lookup.origin,
        radiusKm: 10,
        now: at,
        candidates: input.stores.map((s) => ({
          store: { ...s, storeStatus: 'ACTIVE', reservationAvailable: true, pickupAvailable: true },
          inventory: { quantity: stockOf(s.storeId), reservedQuantity: 0 },
        })),
      });
      const storeById = new Map(input.stores.map((s) => [s.storeId, s]));
      const find: NearbyStoresOutput = {
        status: 'OK',
        variant: {
          variant_id: lookup.variant.variantId,
          product_id: lookup.variant.productId,
          product_title: lookup.variant.productTitle,
          variant_title: lookup.variant.title,
          sku: lookup.variant.sku,
          price: lookup.variant.price,
          currency: lookup.variant.currency,
          online_url: null,
        },
        origin: { source: 'SHARED', approximate: false, locality: null },
        origin_point: lookup.origin,
        radius_km: 10,
        skipped_stores: [],
        eligible: result.eligible.map((e) => {
          const s = storeById.get(e.storeId)!;
          return {
            store_id: s.storeId,
            store_name: s.storeName,
            locality: primaryLocality(s),
            address: s.address,
            city: s.city,
            latitude: s.latitude,
            longitude: s.longitude,
            timezone: s.storeHours.timezone ?? tz,
            distance_km: Math.round(e.distanceKm * 10) / 10,
            open_until: null,
            available_quantity: e.availableQuantity,
            offline_price: lookup.variant.price,
          };
        }),
        excluded: result.excluded
          .map((x) => ({
            store_id: x.storeId,
            store_name: x.storeName,
            locality: primaryLocality(storeById.get(x.storeId)!),
            reason: x.reason,
            distance_km: x.distanceKm === null ? null : Math.round(x.distanceKm * 10) / 10,
            timezone: storeById.get(x.storeId)!.storeHours.timezone ?? tz,
          }))
          // nearest first, exactly like the live find_nearby_stores tool
          .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity)),
        ambiguous_areas: [],
      };

      const rec = (
        action: RecommendationRecord['action'],
        minutes: number,
        store: string | null,
      ): RecommendationRecord => {
        const r: RecommendationRecord = {
          recommendationId: hashedId('rec', `${brandId}:history:${input.seed}:${seq}:${action}`, 20),
          brandId,
          customerId,
          conversationId: conversation!.conversationId,
          intentId,
          action,
          targetStoreId: store,
          targetVariantId: lookup.variant.variantId,
          confidence: 0.85,
          rationaleSummary: 'Synthetic demo history.',
          evidenceReferences: [],
          runtime: 'MOCK',
          decisionSource: 'AGENT',
          guardrailStatus: 'ALLOWED',
          guardrailReason: null,
          proposedAt: new Date(at.getTime() + minutes * 60_000).toISOString(),
          trace: null,
        };
        out.recommendations.push(r);
        return r;
      };

      const best = find.eligible[0];
      let lastRec: RecommendationRecord;
      let purchase: {
        type: PurchaseType;
        storeId: string | null;
        reservationId: string | null;
        order: string | null;
        variantId: string | null;
        value: number;
        at: string;
        evidence: OutcomeRecord['evidence'];
      } | null = null;

      if (!best) {
        lastRec = rec('ONLINE_PURCHASE', 0, null);
        event(
          iso,
          'STORE_RECOMMENDATION',
          customerId,
          lastRec.recommendationId,
          unmetDemandPayload(find, at),
          `UNMET:${seq}`,
        );
      } else {
        lastRec = rec('STORE_DISCOVERY', 0, best.store_id);
        event(
          iso,
          'STORE_RECOMMENDATION',
          customerId,
          lastRec.recommendationId,
          {
            kind: 'PROPOSED',
            variant_id: lookup.variant.variantId,
            sku: lookup.variant.sku,
            stores: [best.store_id],
            ...nearestOf(find),
          },
          `PROPOSED:${seq}`,
        );
        if (rnd() < 0.45) {
          // A hold, then the store's actions through the live transition rules.
          lastRec = rec('STORE_RESERVATION', 2, best.store_id);
          const created = new Date(at.getTime() + 2 * 60_000);
          const store = storeById.get(best.store_id)!;
          let r: ReservationRecord = {
            reservationId: ReservationService.idFor(brandId, lastRec.recommendationId),
            brandId,
            retailerId: store.retailerId,
            customerId,
            storeId: store.storeId,
            variantId: lookup.variant.variantId,
            sku: lookup.variant.sku,
            canonicalSku: lookup.variant.canonicalSku,
            quantity: 1,
            status: 'PENDING',
            idempotencyKey: lastRec.recommendationId,
            aiRecommendationId: lastRec.recommendationId,
            pickupCode: generatePickupCode((max) => Math.floor(rnd() * max)),
            customerEta: null,
            createdAt: created.toISOString(),
            expiresAt: new Date(created.getTime() + 2 * HOUR).toISOString(),
            confirmedAt: null,
            readyAt: null,
            customerArrivedAt: null,
            completedAt: null,
            cancelledAt: null,
            cancelledBy: null,
            cancelReason: null,
            cancelNote: null,
            pickupCodeAttempts: 0,
            lastNotification: null,
          };
          const roll = rnd();
          const steps: { to: ReservationStatus; extra?: Record<string, string> }[] =
            roll < 0.6
              ? [
                  { to: 'CONFIRMED' },
                  { to: 'READY' },
                  { to: 'CUSTOMER_ARRIVED' },
                  { to: 'COMPLETED', extra: { pickupCode: r.pickupCode } },
                ]
              : roll < 0.72
                ? [
                    {
                      to: 'CANCELLED',
                      extra: {
                        cancelReason:
                          store.storeId === andheri?.storeId && weekday === 'saturday'
                            ? 'NOT_ACTUALLY_IN_STOCK'
                            : pick(REFUSALS),
                      },
                    },
                  ]
                : [];
          let t = created.getTime();
          for (const step of steps) {
            t += between(5, 25) * 60_000;
            const d = decideRetailerTransition(
              r,
              { to: step.to, expectedCurrentStatus: r.status, ...step.extra } as never,
              new Date(t).toISOString(),
            );
            if (d.kind !== 'APPLY') break;
            r = { ...r, ...d.plan.patch, status: d.plan.to } as ReservationRecord;
          }
          if (steps.length === 0) r = { ...r, status: 'EXPIRED' };
          out.reservations.push(r);
          event(
            r.createdAt,
            'RESERVATION_CREATED',
            customerId,
            r.reservationId,
            { store_id: r.storeId, variant_id: r.variantId, quantity: 1, recommendation_id: lastRec.recommendationId },
            `RES:${seq}`,
          );
          if (r.status === 'COMPLETED') {
            purchase = {
              type: purchaseTypeFor('STORE', lookup.variant.variantId, r.variantId),
              storeId: r.storeId,
              reservationId: r.reservationId,
              order: null,
              variantId: r.variantId,
              value: lookup.variant.price,
              at: r.completedAt!,
              evidence: 'RESERVATION_COMPLETED',
            };
          }
        }
      }

      // Online orders: with bw_ref (attributed → ONLINE) or without (unattributed, no outcome).
      if (!purchase) {
        const roll = rnd();
        const orderAt = new Date(at.getTime() + between(30, 300) * 60_000).toISOString();
        const orderRef = `hist_order_${input.seed}_${seq}`;
        if (roll < 0.22) {
          const refHash = hashedId('ref', `${brandId}:history:${seq}`, 40).slice(4);
          out.attributionRefs.push({
            refHash,
            intentId,
            conversationId: conversation.conversationId,
            recommendationId: lastRec.recommendationId,
            createdAt: iso,
            expiresAt: new Date(at.getTime() + 7 * DAY).toISOString(),
          });
          event(
            orderAt,
            'ORDER_CREATED',
            customerId,
            orderRef,
            {
              variant_id: lookup.variant.variantId,
              intent_id: intentId,
              journey_key: `int:${intentId}`,
              attributed_by: 'BW_REF',
            },
            `ORDER:${seq}`,
          );
          purchase = {
            type: purchaseTypeFor('ONLINE', lookup.variant.variantId, lookup.variant.variantId),
            storeId: null,
            reservationId: null,
            order: orderRef,
            variantId: lookup.variant.variantId,
            value: lookup.variant.price,
            at: orderAt,
            evidence: 'ORDER',
          };
        } else if (roll < 0.3) {
          event(
            orderAt,
            'ORDER_CREATED',
            null,
            orderRef,
            { variant_id: lookup.variant.variantId, intent_id: null, journey_key: null, attributed_by: null },
            `ORDER:${seq}`,
          );
        }
      }

      // Exactly one Outcome per journey: the verified purchase, or NONE (every history journey's window has closed).
      const journeyKey = journeyKeyFor({ intentId, conversationId: conversation.conversationId });
      const outcome: OutcomeRecord = {
        outcomeId: OutcomeService.idFor(brandId, journeyKey),
        brandId,
        customerId,
        journeyKey,
        sourceIntentId: intentId,
        conversationId: conversation.conversationId,
        aiRecommendationId: lastRec.recommendationId,
        purchaseType: purchase?.type ?? 'NONE',
        channel: 'SIMULATOR',
        storeId: purchase?.storeId ?? null,
        reservationId: purchase?.reservationId ?? null,
        orderReference: purchase?.order ?? null,
        variantId: purchase?.variantId ?? lookup.variant.variantId,
        value: purchase?.value ?? 0,
        currency: purchase ? lookup.variant.currency : null,
        evidence: purchase?.evidence ?? 'WINDOW_CLOSED',
        timestamp: purchase?.at ?? new Date(at.getTime() + DAY).toISOString(),
      };
      // An outcome in the future (a journey that started yesterday) stays out of the history.
      if (outcome.timestamp <= input.now.toISOString()) out.outcomes.push(outcome);
    }
  }
  return out;
}
