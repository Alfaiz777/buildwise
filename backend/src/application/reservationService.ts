import {
  ACTIVE_RESERVATION_STATUSES,
  EXPIRABLE_STATUSES,
  PICKUP_CODE_ATTEMPTS,
  PICKUP_CODE_MAX_ATTEMPTS,
  checkReservable,
  decideRetailerTransition,
  decideSimpleTransition,
  generatePickupCode,
  maskCustomerRef,
  resolveReservationPolicy,
  retailerActionsFor,
  type ReservationStatus,
  type RetailerTransitionRequest,
} from '../domain/reservationStatus.js';
import type { RetailPrincipal, TenantPrincipal } from '../domain/principal.js';
import { whyThisStore, type WhyHere } from '../domain/storeReason.js';
import { hashedId } from '../lib/ids.js';
import type {
  CreateReservationResult,
  ReservationNotification,
  ReservationRecord,
  ReservationRepository,
  TransitionResult,
} from '../ports/reservations.js';
import type { RecommendationRepository } from '../ports/conversationRepositories.js';
import type { ProductRepository, StoreRepository } from '../ports/repositories.js';
import type { EventRecorder } from './eventRecorder.js';

export interface CreateReservationInput {
  brandId: string;
  customerId: string;
  storeId: string;
  variantId: string;
  quantity: number;
  idempotencyKey: string;
  aiRecommendationId: string | null;
  customerEta: string | null;
}

/**
 * ReservationService (docs/06_INTEGRATION_CONTRACTS.md §7). brand_id and customer_id are
 * always the server-resolved scope (agent tool path: the pipeline's customer); the
 * transaction and its checks live in the repository + domain rules. The AI never calls
 * this directly — only the create_reservation / cancel_reservation tools after the guardrail.
 */
export class ReservationService {
  constructor(
    private readonly deps: {
      reservations: ReservationRepository;
      products: ProductRepository;
      stores: StoreRepository;
      events: EventRecorder;
      now: () => Date;
      pickupCode?: () => string;
      /** UI-3: links a brand's reservation row to its conversation (brand scope only). */
      recommendations?: RecommendationRepository;
    },
  ) {}

  /** reservation_id derives from idempotency_key, so a replay returns the same reservation. */
  static idFor(brandId: string, idempotencyKey: string) {
    return hashedId('res', `${brandId}:${idempotencyKey}`, 20);
  }

  async create(input: CreateReservationInput): Promise<CreateReservationResult> {
    const variant = (await this.deps.products.listVariants(input.brandId)).find((v) => v.variantId === input.variantId);
    if (!variant || !variant.canonicalSku) return { status: 'REJECTED', reason: 'UNKNOWN_VARIANT' };
    const now = this.deps.now().toISOString();
    const result = await this.deps.reservations.create(
      {
        reservationId: ReservationService.idFor(input.brandId, input.idempotencyKey),
        brandId: input.brandId,
        customerId: input.customerId,
        storeId: input.storeId,
        variantId: input.variantId,
        sku: variant.sku,
        canonicalSku: variant.canonicalSku,
        quantity: input.quantity,
        idempotencyKey: input.idempotencyKey,
        aiRecommendationId: input.aiRecommendationId,
        customerEta: input.customerEta,
        now,
      },
      {
        policyOf: resolveReservationPolicy,
        check: checkReservable,
        pickupCode: this.deps.pickupCode ?? (() => generatePickupCode()),
        attempts: PICKUP_CODE_ATTEMPTS,
      },
    );
    if (result.status === 'CREATED') {
      const r = result.reservation;
      await this.deps.events.record({
        brandId: r.brandId,
        customerId: r.customerId,
        eventType: 'RESERVATION_CREATED',
        source: 'QWIKSPOT',
        entityReference: r.reservationId,
        payload: {
          store_id: r.storeId,
          variant_id: r.variantId,
          quantity: r.quantity,
          recommendation_id: r.aiRecommendationId,
        },
        idempotencyKey: `RESERVATION_CREATED:${r.reservationId}`,
        at: now,
      });
      await this.deps.events.audit(r.brandId, {
        action: 'RESERVATION_CREATED',
        targetType: 'RESERVATION',
        targetId: r.reservationId,
        actor: { type: 'AGENT', id: r.aiRecommendationId ?? 'qwikspot' },
      });
    } else if (result.status === 'REJECTED') {
      await this.deps.events.audit(input.brandId, {
        action: 'RESERVATION_REJECTED',
        targetType: 'STORE',
        targetId: input.storeId,
        result: 'DENIED',
        reasonCode: result.reason,
      });
    }
    return result;
  }

  get(brandId: string, reservationId: string) {
    return this.deps.reservations.get(brandId, reservationId);
  }

  /** The customer's own reservation only; anyone else's is NOT_FOUND (never disclosed). */
  async cancelByCustomer(brandId: string, customerId: string, reservationId: string): Promise<TransitionResult> {
    const current = await this.deps.reservations.get(brandId, reservationId);
    if (!current || current.customerId !== customerId) return { status: 'NOT_FOUND' };
    const at = this.deps.now().toISOString();
    const result = await this.deps.reservations.transition(brandId, reservationId, (r) =>
      decideSimpleTransition(r, 'CANCELLED', {
        cancelledAt: at,
        cancelledBy: 'CUSTOMER',
        cancelReason: 'CUSTOMER_REQUEST',
      }),
    );
    if (result.status === 'OK') {
      await this.deps.events.audit(brandId, {
        action: 'RESERVATION_CANCELLED',
        targetType: 'RESERVATION',
        targetId: reservationId,
        reasonCode: 'CUSTOMER_REQUEST',
        actor: { type: 'CUSTOMER', id: customerId },
      });
    }
    return result;
  }

  /** Expiry sweep: each overdue hold is EXPIRED and released in its own transaction. Returns the expired holds. */
  async expireDue(brandId: string): Promise<ReservationRecord[]> {
    const nowIso = this.deps.now().toISOString();
    const expired: ReservationRecord[] = [];
    for (const r of await this.deps.reservations.listExpired(brandId, EXPIRABLE_STATUSES, nowIso)) {
      // re-checked inside the transaction: a hold confirmed or cancelled meanwhile is left alone
      const result = await this.deps.reservations.transition(brandId, r.reservationId, (current) =>
        current.expiresAt <= nowIso
          ? decideSimpleTransition(current, 'EXPIRED', {})
          : { kind: 'REJECT', reason: 'STALE_STATUS' },
      );
      if (result.status !== 'OK') continue;
      expired.push(result.reservation);
      await this.deps.events.audit(brandId, {
        action: 'RESERVATION_EXPIRED',
        targetType: 'RESERVATION',
        targetId: r.reservationId,
        actor: { type: 'SYSTEM', id: 'expiry-sweep' },
      });
    }
    return expired;
  }

  /**
   * A store's status change (docs/06 §14.4 PATCH). The reservation must belong to the
   * principal's own store — anything else is 404, never disclosed. The decision is the
   * pure domain rule, evaluated inside the transaction on the fresh document.
   */
  async retailerTransition(
    principal: RetailPrincipal,
    reservationId: string,
    request: RetailerTransitionRequest,
  ): Promise<TransitionResult> {
    const current = await this.deps.reservations.get(principal.brandId, reservationId);
    if (!current || current.storeId !== principal.storeId) return { status: 'NOT_FOUND' };
    const nowIso = this.deps.now().toISOString();
    const result = await this.deps.reservations.transition(principal.brandId, reservationId, (fresh) =>
      fresh.storeId !== principal.storeId
        ? { kind: 'REJECT', reason: 'INVALID_TRANSITION' }
        : decideRetailerTransition(fresh, request, nowIso),
    );
    const actor = { type: 'USER' as const, id: principal.userId };
    if (result.status === 'REJECTED') {
      await this.deps.events.audit(principal.brandId, {
        action: result.reason.startsWith('PICKUP_CODE') ? 'PICKUP_CODE_REJECTED' : 'RESERVATION_TRANSITION_REJECTED',
        targetType: 'RESERVATION',
        targetId: reservationId,
        result: 'DENIED',
        reasonCode: result.reason,
        actor,
      });
      return result;
    }
    if (result.status !== 'OK') return result;
    const r = result.reservation;
    await this.deps.events.audit(principal.brandId, {
      action: `RESERVATION_${r.status}`,
      targetType: 'RESERVATION',
      targetId: reservationId,
      reasonCode: r.status === 'CANCELLED' ? r.cancelReason : null,
      actor,
    });
    if (r.status === 'CANCELLED' && r.cancelReason === 'NOT_ACTUALLY_IN_STOCK') {
      await this.deps.events.audit(principal.brandId, {
        action: 'INVENTORY_CORRECTED_BY_RETAILER',
        targetType: 'INVENTORY',
        targetId: `${r.storeId}__${r.canonicalSku}`,
        reasonCode: 'NOT_ACTUALLY_IN_STOCK',
        actor,
      });
    }
    const base = {
      brandId: r.brandId,
      customerId: r.customerId,
      source: 'QWIKSPOT' as const,
      entityReference: r.reservationId,
      at: nowIso,
    };
    if (r.status === 'CONFIRMED') {
      await this.deps.events.record({
        ...base,
        eventType: 'RESERVATION_CONFIRMED',
        payload: { store_id: r.storeId, variant_id: r.variantId },
        idempotencyKey: `RESERVATION_CONFIRMED:${r.reservationId}`,
      });
    }
    if (r.status === 'COMPLETED') {
      for (const eventType of ['PICKUP_COMPLETED', 'OFFLINE_PURCHASE'] as const) {
        await this.deps.events.record({
          ...base,
          eventType,
          payload: { store_id: r.storeId, variant_id: r.variantId, quantity: r.quantity },
          idempotencyKey: `${eventType}:${r.reservationId}`,
        });
      }
    }
    return result;
  }

  setNotification(brandId: string, reservationId: string, notification: ReservationNotification) {
    return this.deps.reservations.setNotification(brandId, reservationId, notification);
  }

  /** The Retailer Console "This week" strip for the own store (created in the last 7 days). */
  /**
   * The store's value strip (M6 "This week"; UI-4): the last 7 days of its reservations.
   * Completion = picked up ÷ finished holds (active ones are left out). Value = Σ quantity
   * × the store's CURRENT offline price per SKU — an estimate, so the UI says "est.".
   */
  async weekSummary(principal: RetailPrincipal, prices: Map<string, number> = new Map(), currency = 'INR') {
    const since = new Date(this.deps.now().getTime() - 7 * 24 * 60 * 60_000).toISOString();
    const rows = (
      await this.deps.reservations.list(principal.brandId, { storeId: principal.storeId, limit: 1000 })
    ).filter((r) => r.createdAt >= since);
    const completed = rows.filter((r) => r.status === 'COMPLETED');
    const finished = rows.filter((r) => !ACTIVE_RESERVATION_STATUSES.includes(r.status));
    return {
      days: 7,
      reservations: rows.length,
      completed: completed.length,
      refused: rows.filter((r) => r.status === 'CANCELLED' && r.cancelledBy === 'RETAILER').length,
      expired: rows.filter((r) => r.status === 'EXPIRED').length,
      completion_pct: finished.length === 0 ? null : Math.round((completed.length / finished.length) * 100),
      value: {
        amount: completed.reduce((sum, r) => sum + r.quantity * (prices.get(r.sku) ?? 0), 0),
        currency,
      },
      synthetic: rows.filter((r) => r.demoHistory === true).length,
    };
  }

  listForCustomer(brandId: string, customerId: string) {
    return this.deps.reservations.list(brandId, { customerId, limit: 50 });
  }

  /**
   * GET /api/reservations (docs/06 §14.4): BRAND_ADMIN sees its brand; RETAIL_ADMIN only
   * its own store (any other store_id → empty list). Customers are masked.
   */
  async listFor(
    principal: TenantPrincipal,
    filter: { storeId?: string; status?: ReservationStatus; view?: 'active' | 'history'; limit: number },
  ) {
    if (principal.scope === 'RETAIL') {
      if (filter.storeId && filter.storeId !== principal.storeId) return [];
      filter = { ...filter, storeId: principal.storeId };
    }
    const rows = (
      await this.deps.reservations.list(principal.brandId, { ...filter, limit: filter.view ? 500 : filter.limit })
    ).filter((r) =>
      filter.view === 'active'
        ? ACTIVE_RESERVATION_STATUSES.includes(r.status)
        : filter.view === 'history'
          ? !ACTIVE_RESERVATION_STATUSES.includes(r.status)
          : true,
    );
    const ordered = (filter.view === 'active' ? sortQueue(rows) : rows).slice(0, filter.limit);
    const lookup = await this.lookup(principal.brandId);
    if (principal.scope !== 'BRAND') {
      const why = await this.whyHere(principal.brandId, ordered);
      return ordered.map((r) => ({ ...view(r, lookup), ...storeFields(r, lookup, why) }));
    }
    const conversations = await this.conversationIds(principal.brandId, ordered);
    return ordered.map((r) => ({ ...view(r, lookup), ...brandFields(r, lookup, conversations) }));
  }

  /**
   * UI-4 "Why this hold came to you": from the decision that offered this store. A hold's
   * own decision often carries no store lists, so the conversation's earlier decisions are
   * searched (newest first) for the trace that lists this store. Store-safe output only.
   */
  private async whyHere(brandId: string, rows: ReservationRecord[]) {
    const out = new Map<string, WhyHere | null>();
    const recs = this.deps.recommendations;
    if (!recs) return out;
    await Promise.all(
      rows.map(async (r) => {
        if (!r.aiRecommendationId) return out.set(r.reservationId, null);
        const hold = await recs.get(brandId, r.aiRecommendationId);
        if (!hold) return out.set(r.reservationId, null);
        // The hold's own decision often re-checks only the chosen store; the reason lives in the
        // decision that offered the choice (the latest one listing more than this one store).
        const earlier = (await recs.listByConversation(brandId, hold.conversationId))
          .filter((x) => x.recommendationId !== hold.recommendationId && x.proposedAt <= hold.proposedAt)
          .reverse();
        const lists = (t: typeof hold.trace) =>
          !!t && t.eligible.some((e) => e.store_id === r.storeId) && t.eligible.length + t.excluded.length > 1;
        const chain = [hold, ...earlier];
        const source = chain.find((x) => lists(x.trace)) ?? hold;
        // "Other stores" leaves out the store offered first: merge the stores seen by every
        // decision made from the same customer position (this store at the same distance).
        const ownKm = source.trace?.eligible.find((e) => e.store_id === r.storeId)?.distance_km;
        const sameSpot = chain.filter((x) => {
          const km = x.trace?.eligible.find((e) => e.store_id === r.storeId)?.distance_km;
          return ownKm !== undefined && km !== undefined && Math.abs(km - ownKm) < 0.05;
        });
        const unique = <T extends { store_id: string }>(list: T[]) =>
          list.filter((x, i) => list.findIndex((y) => y.store_id === x.store_id) === i);
        const eligible = unique(sameSpot.flatMap((x) => x.trace!.eligible));
        const merged = source.trace
          ? {
              eligible,
              excluded: unique(sameSpot.flatMap((x) => x.trace!.excluded)).filter(
                (x) => !eligible.some((e) => e.store_id === x.store_id),
              ),
            }
          : null;
        // A store that refused this customer's earlier hold for the same product is the reason, not a choice.
        const refusedIds = [
          ...new Set(
            (await this.deps.reservations.list(brandId, { customerId: r.customerId, limit: 50 }))
              .filter(
                (x) =>
                  x.reservationId !== r.reservationId &&
                  x.cancelledBy === 'RETAILER' &&
                  x.variantId === r.variantId &&
                  x.storeId !== r.storeId &&
                  x.createdAt <= r.createdAt,
              )
              .map((x) => x.storeId),
          ),
        ];
        const refusedBy = await Promise.all(
          refusedIds.map(async (id) => ({
            store_id: id,
            store_name: (await this.deps.stores.get(brandId, id))?.storeName ?? 'Another store',
          })),
        );
        // The refusal re-offer can reach beyond the normal radius (judge-test fixes): the first
        // search then listed this store as too far — its distance is still the one to show.
        const describes = (t: typeof merged) => !!t && t.eligible.some((e) => e.store_id === r.storeId);
        let trace = describes(merged) ? merged : hold.trace;
        if (refusedBy.length > 0 && !describes(trace)) {
          const seen = chain.find((x) =>
            x.trace?.excluded.some((e) => e.store_id === r.storeId && e.distance_km !== null),
          );
          if (seen?.trace) {
            const own = seen.trace.excluded.find((e) => e.store_id === r.storeId)!;
            trace = {
              ...seen.trace,
              eligible: [
                ...seen.trace.eligible,
                {
                  store_id: own.store_id,
                  store_name: own.store_name,
                  distance_km: own.distance_km!,
                  variant_id: own.variant_id,
                },
              ],
              excluded: seen.trace.excluded.filter((e) => e.store_id !== r.storeId),
            };
          }
        }
        out.set(r.reservationId, whyThisStore(trace, r.storeId, r.variantId, refusedBy));
      }),
    );
    return out;
  }

  /**
   * UI-3: the conversation each reservation came from, via its AI recommendation. Only the
   * brand's own rows get it — the store never sees conversations.
   */
  private async conversationIds(brandId: string, rows: ReservationRecord[]) {
    const ids = [...new Set(rows.map((r) => r.aiRecommendationId).filter((id): id is string => !!id))];
    const recs = this.deps.recommendations
      ? await Promise.all(ids.map((id) => this.deps.recommendations!.get(brandId, id)))
      : [];
    return new Map(ids.map((id, i) => [id, recs[i]?.conversationId ?? null]));
  }

  /** GET /api/reservations/:id: same scoping as the list; anything else → null (404). */
  async getFor(principal: TenantPrincipal, reservationId: string) {
    const r = await this.deps.reservations.get(principal.brandId, reservationId);
    if (!r || (principal.scope === 'RETAIL' && r.storeId !== principal.storeId)) return null;
    const lookup = await this.lookup(principal.brandId);
    if (principal.scope !== 'BRAND')
      return { ...view(r, lookup), ...storeFields(r, lookup, await this.whyHere(principal.brandId, [r])) };
    return { ...view(r, lookup), ...brandFields(r, lookup, await this.conversationIds(principal.brandId, [r])) };
  }

  async viewOf(brandId: string, r: ReservationRecord) {
    return view(r, await this.lookup(brandId));
  }

  private async lookup(brandId: string): Promise<Lookup> {
    const [products, variants, stores] = await Promise.all([
      this.deps.products.listProducts(brandId),
      this.deps.products.listVariants(brandId),
      this.deps.stores.list(brandId),
    ]);
    return {
      variants: new Map(variants.map((v) => [v.variantId, v])),
      products: new Map(products.map((p) => [p.productId, p])),
      stores: new Map(stores.map((s) => [s.storeId, s])),
    };
  }
}

interface Lookup {
  variants: Map<string, { productId: string; title: string }>;
  products: Map<string, { title: string; imageUrl?: string | null }>;
  stores: Map<string, { storeName: string; storeHours: Record<string, string> | null }>;
}

/** The store's queue order: PENDING first (needs a decision), then the soonest expiry. */
export function sortQueue<T extends { status: ReservationStatus; expiresAt: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => Number(b.status === 'PENDING') - Number(a.status === 'PENDING') || a.expiresAt.localeCompare(b.expiresAt),
  );
}

/**
 * Store-only row fields (UI-4): why the hold came here (store names and this store's
 * distance only), the product image and the synthetic flag. Never a conversation,
 * recommendation, customer or location.
 */
function storeFields(r: ReservationRecord, lookup: Lookup, why: Map<string, WhyHere | null>) {
  const variant = lookup.variants.get(r.variantId);
  return {
    why_here: why.get(r.reservationId) ?? null,
    image_url: variant ? (lookup.products.get(variant.productId)?.imageUrl ?? null) : null,
    demo_history: r.demoHistory === true,
  };
}

/** Brand-only row fields (UI-3): its conversation, the product image and the synthetic flag. */
function brandFields(r: ReservationRecord, lookup: Lookup, conversations: Map<string, string | null>) {
  const variant = lookup.variants.get(r.variantId);
  return {
    conversation_id: r.aiRecommendationId ? (conversations.get(r.aiRecommendationId) ?? null) : null,
    image_url: variant ? (lookup.products.get(variant.productId)?.imageUrl ?? null) : null,
    demo_history: r.demoHistory === true,
  };
}

function view(r: ReservationRecord, lookup: Lookup) {
  const variant = lookup.variants.get(r.variantId);
  const store = lookup.stores.get(r.storeId);
  const locked = r.pickupCodeAttempts >= PICKUP_CODE_MAX_ATTEMPTS;
  return {
    reservation_id: r.reservationId,
    store_id: r.storeId,
    store_name: store?.storeName ?? r.storeId,
    store_timezone: store?.storeHours?.timezone ?? 'UTC',
    product_title: variant ? (lookup.products.get(variant.productId)?.title ?? null) : null,
    variant_title: variant?.title ?? null,
    sku: r.sku,
    quantity: r.quantity,
    status: r.status,
    active: ACTIVE_RESERVATION_STATUSES.includes(r.status),
    allowed_actions: retailerActionsFor(r.status, locked),
    pickup_code_locked: locked,
    customer_display: maskCustomerRef(r.customerId),
    customer_eta: r.customerEta,
    created_at: r.createdAt,
    expires_at: r.expiresAt,
    confirmed_at: r.confirmedAt,
    ready_at: r.readyAt,
    customer_arrived_at: r.customerArrivedAt,
    completed_at: r.completedAt,
    cancelled_at: r.cancelledAt,
    cancelled_by: r.cancelledBy,
    cancel_reason: r.cancelReason,
    last_notification: r.lastNotification
      ? {
          status: r.lastNotification.status,
          event: r.lastNotification.event,
          message_kind: r.lastNotification.messageKind,
          at: r.lastNotification.at,
        }
      : null,
  };
}

export type ReservationView = ReturnType<typeof view>;
