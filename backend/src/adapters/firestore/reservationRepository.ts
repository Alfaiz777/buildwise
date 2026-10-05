import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  ACTIVE_RESERVATION_STATUSES,
  applyInventoryPlan,
  type ReservationStatus,
  type TransitionDecision,
} from '../../domain/reservationStatus.js';
import { deriveAvailabilityStatus } from '../../domain/storeTruth.js';
import type {
  CreateReservationRequest,
  CreateReservationResult,
  CreateReservationRules,
  ReservationNotification,
  ReservationRecord,
  ReservationRepository,
  TransitionResult,
} from '../../ports/reservations.js';
import { inventoryIdFor } from './repositories.js';

/**
 * Firestore reservations (docs/03_TECH_ARCHITECTURE.md §15). Every reservation for the
 * same store × SKU reads and writes the same retailInventory document inside its
 * transaction, so Firestore serializes competing requests: the loser retries, re-reads
 * reserved_quantity and fails the availability check. Nothing is written on a failed check.
 */

const toRecord = (id: string, d: FirebaseFirestore.DocumentData): ReservationRecord => ({
  reservationId: id,
  brandId: d.brand_id,
  retailerId: d.retailer_id ?? null,
  customerId: d.customer_id,
  storeId: d.store_id,
  variantId: d.variant_id,
  sku: d.sku,
  canonicalSku: d.canonical_sku,
  quantity: d.quantity,
  status: d.status,
  idempotencyKey: d.idempotency_key,
  aiRecommendationId: d.ai_recommendation_id ?? null,
  pickupCode: d.pickup_code,
  customerEta: d.customer_eta ?? null,
  createdAt: d.created_at,
  expiresAt: d.expires_at,
  confirmedAt: d.confirmed_at ?? null,
  readyAt: d.ready_at ?? null,
  customerArrivedAt: d.customer_arrived_at ?? null,
  completedAt: d.completed_at ?? null,
  cancelledAt: d.cancelled_at ?? null,
  cancelledBy: d.cancelled_by ?? null,
  cancelReason: d.cancel_reason ?? null,
  cancelNote: d.cancel_note ?? null,
  demoHistory: d.demo_history === true,
  pickupCodeAttempts: Number(d.pickup_code_attempts ?? 0),
  lastNotification: d.last_notification
    ? {
        status: d.last_notification.status,
        event: d.last_notification.event,
        messageKind: d.last_notification.message_kind ?? null,
        at: d.last_notification.at,
      }
    : null,
});

function toDoc(r: ReservationRecord) {
  return {
    reservation_id: r.reservationId,
    brand_id: r.brandId,
    retailer_id: r.retailerId,
    customer_id: r.customerId,
    store_id: r.storeId,
    variant_id: r.variantId,
    sku: r.sku,
    canonical_sku: r.canonicalSku,
    quantity: r.quantity,
    status: r.status,
    idempotency_key: r.idempotencyKey,
    ai_recommendation_id: r.aiRecommendationId,
    pickup_code: r.pickupCode,
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
    cancel_note: r.cancelNote,
    pickup_code_attempts: r.pickupCodeAttempts,
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

export class FirestoreReservationRepository implements ReservationRepository {
  constructor(private readonly db: Firestore) {}

  private brand(brandId: string) {
    return this.db.collection('brands').doc(brandId);
  }
  private col(brandId: string) {
    return this.brand(brandId).collection('reservations');
  }

  async create(req: CreateReservationRequest, rules: CreateReservationRules): Promise<CreateReservationResult> {
    const brandRef = this.brand(req.brandId);
    const resRef = this.col(req.brandId).doc(req.reservationId);
    const storeRef = brandRef.collection('stores').doc(req.storeId);
    const invRef = brandRef.collection('retailInventory').doc(inventoryIdFor(req.storeId, req.canonicalSku));

    return this.db.runTransaction(async (tx): Promise<CreateReservationResult> => {
      // 1. idempotent replay
      const existing = await tx.get(resRef);
      if (existing.exists) return { status: 'REPLAYED', reservation: toRecord(existing.id, existing.data()!) };
      // 2–4. store, stock and brand policy, all read inside the transaction
      const [storeSnap, invSnap, brandSnap] = await Promise.all([tx.get(storeRef), tx.get(invRef), tx.get(brandRef)]);
      const policy = rules.policyOf((brandSnap.get('settings') as Record<string, unknown> | undefined) ?? {});
      const inventory = invSnap.exists
        ? {
            quantity: Number(invSnap.get('quantity') ?? 0),
            reservedQuantity: Number(invSnap.get('reserved_quantity') ?? 0),
          }
        : null;
      const rejection = rules.check({
        store: storeSnap.exists
          ? {
              storeStatus: String(storeSnap.get('store_status')),
              reservationAvailable: storeSnap.get('reservation_available') !== false,
            }
          : null,
        inventory,
        policy,
        quantity: req.quantity,
      });
      if (rejection) return { status: 'REJECTED', reason: rejection };

      // 5. a pickup code unique among the store's active reservations
      let pickupCode: string | null = null;
      for (let i = 0; i < rules.attempts && !pickupCode; i++) {
        const candidate = rules.pickupCode();
        const clash = await tx.get(
          this.col(req.brandId).where('store_id', '==', req.storeId).where('pickup_code', '==', candidate),
        );
        if (!clash.docs.some((d) => ACTIVE_RESERVATION_STATUSES.includes(d.get('status')))) pickupCode = candidate;
      }
      if (!pickupCode) return { status: 'REJECTED', reason: 'PICKUP_CODE_UNAVAILABLE' };

      // 6–7. write the PENDING reservation and reserve the stock
      const reservation: ReservationRecord = {
        reservationId: req.reservationId,
        brandId: req.brandId,
        retailerId: (storeSnap.get('retailer_id') as string | null) ?? null,
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
      const reserved = inventory!.reservedQuantity + req.quantity;
      tx.create(resRef, toDoc(reservation));
      tx.update(invRef, {
        reserved_quantity: reserved,
        availability_status: deriveAvailabilityStatus(inventory!.quantity, reserved),
      });
      return { status: 'CREATED', reservation };
    });
  }

  async get(brandId: string, reservationId: string) {
    const snap = await this.col(brandId).doc(reservationId).get();
    return snap.exists ? toRecord(snap.id, snap.data()!) : null;
  }

  async transition(
    brandId: string,
    reservationId: string,
    decide: (current: ReservationRecord) => TransitionDecision,
  ): Promise<TransitionResult> {
    const ref = this.col(brandId).doc(reservationId);
    return this.db.runTransaction(async (tx): Promise<TransitionResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { status: 'NOT_FOUND' };
      const current = toRecord(snap.id, snap.data()!);
      const invRef = this.brand(brandId)
        .collection('retailInventory')
        .doc(inventoryIdFor(current.storeId, current.canonicalSku));
      const inv = await tx.get(invRef); // read before any write (Firestore transaction rule)
      const decision = decide(current);
      if (decision.kind === 'REJECT') {
        if (decision.pickupCodeAttempts !== undefined) {
          tx.update(ref, { pickup_code_attempts: decision.pickupCodeAttempts });
        }
        return {
          status: 'REJECTED',
          reason: decision.reason,
          reservation: { ...current, pickupCodeAttempts: decision.pickupCodeAttempts ?? current.pickupCodeAttempts },
        };
      }
      const { plan } = decision;
      let inventory: { quantity: number; reservedQuantity: number } | null = null;
      if (inv.exists) {
        inventory = applyInventoryPlan(
          { quantity: Number(inv.get('quantity') ?? 0), reservedQuantity: Number(inv.get('reserved_quantity') ?? 0) },
          plan,
        );
        tx.update(invRef, {
          quantity: inventory.quantity,
          reserved_quantity: inventory.reservedQuantity,
          availability_status: deriveAvailabilityStatus(inventory.quantity, inventory.reservedQuantity),
          last_updated_at: FieldValue.serverTimestamp(),
        });
      }
      const next = { ...current, ...plan.patch, status: plan.to } as ReservationRecord;
      tx.update(ref, toDoc(next));
      return { status: 'OK', reservation: next, before: current, inventory };
    });
  }

  async setNotification(brandId: string, reservationId: string, n: ReservationNotification) {
    await this.col(brandId)
      .doc(reservationId)
      .update({ last_notification: { status: n.status, event: n.event, message_kind: n.messageKind, at: n.at } });
  }

  async list(
    brandId: string,
    filter: { storeId?: string; customerId?: string; status?: ReservationStatus; limit: number },
  ) {
    let q: FirebaseFirestore.Query = this.col(brandId);
    if (filter.storeId) q = q.where('store_id', '==', filter.storeId);
    if (filter.customerId) q = q.where('customer_id', '==', filter.customerId);
    if (filter.status) q = q.where('status', '==', filter.status);
    const snap = await q.get();
    return snap.docs
      .map((d) => toRecord(d.id, d.data()))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit);
  }

  async listExpired(brandId: string, statuses: readonly ReservationStatus[], nowIso: string) {
    const snap = await this.col(brandId)
      .where('status', 'in', [...statuses])
      .where('expires_at', '<=', nowIso)
      .get();
    return snap.docs.map((d) => toRecord(d.id, d.data()));
  }
}

/** The reservation document shape (for the local synthetic history writer; same mapping as live writes). */
export const reservationToDoc = toDoc;
