import {
  ACTIVE_RESERVATION_STATUSES,
  EXPIRABLE_STATUSES,
  PICKUP_CODE_ATTEMPTS,
  canTransition,
  checkReservable,
  generatePickupCode,
  inventoryEffect,
  maskCustomerRef,
  resolveReservationPolicy,
  type ReservationStatus,
} from '../domain/reservationStatus.js';
import type { TenantPrincipal } from '../domain/principal.js';
import { hashedId } from '../lib/ids.js';
import type { CreateReservationResult, ReservationRecord, ReservationRepository } from '../ports/reservations.js';
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
        source: 'BUILDWISE',
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
        actor: { type: 'AGENT', id: r.aiRecommendationId ?? 'buildwise' },
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
  async cancelByCustomer(brandId: string, customerId: string, reservationId: string) {
    const current = await this.deps.reservations.get(brandId, reservationId);
    if (!current || current.customerId !== customerId) return { status: 'NOT_FOUND' as const };
    const at = this.deps.now().toISOString();
    const result = await this.deps.reservations.transition(brandId, reservationId, 'CANCELLED', {
      allowed: (from) => canTransition(from, 'CANCELLED'),
      effect: (q) => inventoryEffect('CANCELLED', q),
      patch: { cancelledAt: at, cancelledBy: 'CUSTOMER', cancelReason: 'CUSTOMER_REQUEST' },
    });
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

  /** Expiry sweep: each overdue hold is EXPIRED and released in its own transaction. */
  async expireDue(brandId: string): Promise<number> {
    const nowIso = this.deps.now().toISOString();
    let expired = 0;
    for (const r of await this.deps.reservations.listExpired(brandId, EXPIRABLE_STATUSES, nowIso)) {
      const result = await this.deps.reservations.transition(brandId, r.reservationId, 'EXPIRED', {
        // re-checked inside the transaction: a hold confirmed or cancelled meanwhile is left alone
        allowed: (from) => canTransition(from, 'EXPIRED'),
        effect: (q) => inventoryEffect('EXPIRED', q),
        patch: {},
      });
      if (result.status !== 'OK') continue;
      expired++;
      await this.deps.events.audit(brandId, {
        action: 'RESERVATION_EXPIRED',
        targetType: 'RESERVATION',
        targetId: r.reservationId,
        actor: { type: 'SYSTEM', id: 'expiry-sweep' },
      });
    }
    return expired;
  }

  listForCustomer(brandId: string, customerId: string) {
    return this.deps.reservations.list(brandId, { customerId, limit: 50 });
  }

  /**
   * GET /api/reservations (docs/06 §14.4): BRAND_ADMIN sees its brand; RETAIL_ADMIN only
   * its own store (any other store_id → empty list). Customers are masked.
   */
  async listFor(principal: TenantPrincipal, filter: { storeId?: string; status?: ReservationStatus; limit: number }) {
    if (principal.scope === 'RETAIL') {
      if (filter.storeId && filter.storeId !== principal.storeId) return [];
      filter = { ...filter, storeId: principal.storeId };
    }
    const [rows, products, variants, stores] = await Promise.all([
      this.deps.reservations.list(principal.brandId, filter),
      this.deps.products.listProducts(principal.brandId),
      this.deps.products.listVariants(principal.brandId),
      this.deps.stores.list(principal.brandId),
    ]);
    const variantById = new Map(variants.map((v) => [v.variantId, v]));
    const productById = new Map(products.map((p) => [p.productId, p]));
    const storeById = new Map(stores.map((s) => [s.storeId, s]));
    return rows.map((r) => view(r, variantById, productById, storeById));
  }
}

function view(
  r: ReservationRecord,
  variants: Map<string, { productId: string; title: string }>,
  products: Map<string, { title: string }>,
  stores: Map<string, { storeName: string }>,
) {
  const variant = variants.get(r.variantId);
  return {
    reservation_id: r.reservationId,
    store_id: r.storeId,
    store_name: stores.get(r.storeId)?.storeName ?? r.storeId,
    product_title: variant ? (products.get(variant.productId)?.title ?? null) : null,
    variant_title: variant?.title ?? null,
    sku: r.sku,
    quantity: r.quantity,
    status: r.status,
    active: ACTIVE_RESERVATION_STATUSES.includes(r.status),
    customer_display: maskCustomerRef(r.customerId),
    created_at: r.createdAt,
    expires_at: r.expiresAt,
  };
}
