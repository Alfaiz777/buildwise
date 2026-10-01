/** In-memory ReservationRepository with the same transactional semantics as Firestore (serialized). */
import {
  ACTIVE_RESERVATION_STATUSES,
  applyInventoryPlan,
  type ReservationStatus,
  type TransitionDecision,
} from '../src/domain/reservationStatus.js';
import { deriveAvailabilityStatus } from '../src/domain/storeTruth.js';
import type {
  CreateReservationRequest,
  CreateReservationResult,
  CreateReservationRules,
  ReservationNotification,
  ReservationRecord,
  ReservationRepository,
  TransitionResult,
} from '../src/ports/reservations.js';
import type { BrandRecord, InventoryRecord, StoreRecord } from '../src/ports/repositories.js';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryReservations implements ReservationRepository {
  readonly reservations: ReservationRecord[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly source: {
      brands: { brands: BrandRecord[] };
      stores: { list(brandId: string): Promise<StoreRecord[]> };
      inventory: { rows: InventoryRecord[] };
    },
  ) {}

  /** One "transaction" at a time, like Firestore's serialization on the inventory document. */
  private tx<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  create(req: CreateReservationRequest, rules: CreateReservationRules): Promise<CreateReservationResult> {
    return this.tx(async () => {
      const existing = this.reservations.find(
        (r) => r.brandId === req.brandId && r.reservationId === req.reservationId,
      );
      if (existing) return { status: 'REPLAYED', reservation: clone(existing) };
      const store = (await this.source.stores.list(req.brandId)).find((s) => s.storeId === req.storeId) ?? null;
      const inv = this.source.inventory.rows.find(
        (r) => r.brandId === req.brandId && r.inventoryId === `${req.storeId}__${req.canonicalSku}`,
      );
      const brand = this.source.brands.brands.find((b) => b.brandId === req.brandId);
      const policy = rules.policyOf(brand?.settings ?? {});
      const rejection = rules.check({
        store: store ? { storeStatus: store.storeStatus, reservationAvailable: store.reservationAvailable } : null,
        inventory: inv ? { quantity: inv.quantity, reservedQuantity: inv.reservedQuantity } : null,
        policy,
        quantity: req.quantity,
      });
      if (rejection) return { status: 'REJECTED', reason: rejection };
      let pickupCode: string | null = null;
      for (let i = 0; i < rules.attempts && !pickupCode; i++) {
        const candidate = rules.pickupCode();
        const clash = this.reservations.some(
          (r) =>
            r.brandId === req.brandId &&
            r.storeId === req.storeId &&
            r.pickupCode === candidate &&
            ACTIVE_RESERVATION_STATUSES.includes(r.status),
        );
        if (!clash) pickupCode = candidate;
      }
      if (!pickupCode) return { status: 'REJECTED', reason: 'PICKUP_CODE_UNAVAILABLE' };
      const reservation: ReservationRecord = {
        reservationId: req.reservationId,
        brandId: req.brandId,
        retailerId: store!.retailerId,
        customerId: req.customerId,
        storeId: req.storeId,
        variantId: req.variantId,
        sku: req.sku,
        canonicalSku: req.canonicalSku,
        quantity: req.quantity,
        status: 'PENDING',
        idempotencyKey: req.idempotencyKey,
        aiRecommendationId: req.aiRecommendationId,
        pickupCode,
        customerEta: req.customerEta,
        createdAt: req.now,
        expiresAt: new Date(new Date(req.now).getTime() + policy.holdMinutes * 60_000).toISOString(),
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
      this.reservations.push(reservation);
      inv!.reservedQuantity += req.quantity;
      inv!.availabilityStatus = deriveAvailabilityStatus(inv!.quantity, inv!.reservedQuantity);
      return { status: 'CREATED', reservation: clone(reservation) };
    });
  }

  async get(brandId: string, reservationId: string) {
    const r = this.reservations.find((x) => x.brandId === brandId && x.reservationId === reservationId);
    return r ? clone(r) : null;
  }

  transition(
    brandId: string,
    reservationId: string,
    decide: (current: ReservationRecord) => TransitionDecision,
  ): Promise<TransitionResult> {
    return this.tx(async () => {
      const r = this.reservations.find((x) => x.brandId === brandId && x.reservationId === reservationId);
      if (!r) return { status: 'NOT_FOUND' };
      const before = clone(r);
      const decision = decide(clone(r));
      if (decision.kind === 'REJECT') {
        if (decision.pickupCodeAttempts !== undefined) r.pickupCodeAttempts = decision.pickupCodeAttempts;
        return { status: 'REJECTED', reason: decision.reason, reservation: clone(r) };
      }
      const inv = this.source.inventory.rows.find(
        (x) => x.brandId === brandId && x.inventoryId === `${r.storeId}__${r.canonicalSku}`,
      );
      let inventory: { quantity: number; reservedQuantity: number } | null = null;
      if (inv) {
        inventory = applyInventoryPlan(inv, decision.plan);
        inv.quantity = inventory.quantity;
        inv.reservedQuantity = inventory.reservedQuantity;
        inv.availabilityStatus = deriveAvailabilityStatus(inv.quantity, inv.reservedQuantity);
      }
      Object.assign(r, decision.plan.patch, { status: decision.plan.to });
      return { status: 'OK', reservation: clone(r), before, inventory };
    });
  }

  async setNotification(brandId: string, reservationId: string, notification: ReservationNotification) {
    const r = this.reservations.find((x) => x.brandId === brandId && x.reservationId === reservationId);
    if (r) r.lastNotification = clone(notification);
  }

  async list(
    brandId: string,
    filter: { storeId?: string; customerId?: string; status?: ReservationStatus; limit: number },
  ) {
    return clone(
      this.reservations
        .filter(
          (r) =>
            r.brandId === brandId &&
            (!filter.storeId || r.storeId === filter.storeId) &&
            (!filter.customerId || r.customerId === filter.customerId) &&
            (!filter.status || r.status === filter.status),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, filter.limit),
    );
  }

  async listExpired(brandId: string, statuses: readonly ReservationStatus[], nowIso: string) {
    return clone(
      this.reservations.filter((r) => r.brandId === brandId && statuses.includes(r.status) && r.expiresAt <= nowIso),
    );
  }
}
