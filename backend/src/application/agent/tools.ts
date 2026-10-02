/**
 * Agent tool handlers (docs/05_AI_AGENT_SPEC.md §6). In-process backend functions over the
 * same repositories and services as the HTTP API. Every handler receives the pipeline's
 * scope; nothing here reads a brand or customer from the agent's arguments.
 */
import type {
  BrandPolicyOutput,
  CustomerHistoryOutput,
  ExcludedStoreView,
  NearbyStoresOutput,
  ProductContextOutput,
  ProductSheet,
  ReservationToolOutput,
  StoreHoursOutput,
  StoreInventoryOutput,
  StoreOption,
  VariantView,
} from '../../domain/agentTools.js';
import { INTENT_TYPES, type IntentType } from '../../domain/ai.js';
import {
  isStockStale,
  onlineProductUrl,
  resolveFreshnessHours,
  resolveMessagingSettings,
} from '../../domain/brandSettings.js';
import { primaryLocality, resolveLocality, roundCoordinate } from '../../domain/locality.js';
import { ACTIVE_RESERVATION_STATUSES, resolveReservationPolicy } from '../../domain/reservationStatus.js';
import { closingTimeToday, isOpenNow } from '../../domain/storeHours.js';
import {
  availableQuantity,
  deriveAvailabilityStatus,
  findEligibleStores,
  type GeoPoint,
} from '../../domain/storeTruth.js';
import type {
  ConversationRepository,
  CustomerRepository,
  IntentRepository,
} from '../../ports/conversationRepositories.js';
import type { ToolInput } from '../../ports/agentTools.js';
import type {
  BrandRepository,
  InventoryRepository,
  ProductRecord,
  ProductRepository,
  StoreRecord,
  StoreRepository,
  VariantRecord,
} from '../../ports/repositories.js';
import type { EventRecorder } from '../eventRecorder.js';
import type { ReservationService } from '../reservationService.js';
import type { ToolHandlers, ToolOutcome, ToolScope } from './toolExecutor.js';

export const DEFAULT_RADIUS_KM = 10;

/** Intent types the conversation may refine to (docs/05 §8: type only, never the stage). */
export const CONVERSATIONAL_INTENT_TYPES: readonly IntentType[] = ['PRODUCT_QUESTION', 'COMPARISON', 'URGENT_PURCHASE'];

export interface ToolDeps {
  brands: BrandRepository;
  products: ProductRepository;
  stores: StoreRepository;
  inventory: InventoryRepository;
  customers: CustomerRepository;
  conversations: ConversationRepository;
  intents: IntentRepository;
  reservations: ReservationService;
  events: EventRecorder;
  now: () => Date;
}

const ok = (output: unknown): ToolOutcome => ({ status: 'EXECUTED', output });

export function sheetOf(
  product: ProductRecord,
  variants: VariantRecord[],
  settings: Record<string, unknown>,
): ProductSheet {
  return {
    product_id: product.productId,
    title: product.title,
    description: product.description,
    category: product.category,
    tags: product.tags,
    attributes: product.attributes,
    variants: variants
      .filter((v) => v.productId === product.productId && v.status !== 'ARCHIVED')
      .map((v) => ({ variant_id: v.variantId, title: v.title, sku: v.sku, price: v.price, currency: v.currency })),
    online_url: onlineProductUrl(settings, product.productId),
  };
}

/** Same `concern` attribute, other active products (docs: one verified alternative per hero product). */
export function alternativesOf(product: ProductRecord, products: ProductRecord[]): ProductRecord[] {
  const concern = product.attributes.concern;
  if (!concern) return [];
  return products.filter(
    (p) => p.productId !== product.productId && p.status === 'ACTIVE' && p.attributes.concern === concern,
  );
}

const norm = (s: string) => s.toLowerCase().replace(/(\d)\s+(ml|g)\b/g, '$1$2');
const tokens = (s: string) =>
  norm(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A unique product (and variant) named in free text, or the candidates when several match. */
export function matchCatalog(query: string, products: ProductRecord[], variants: VariantRecord[]) {
  const words = new Set(tokens(query));
  const scored = products
    .filter((p) => p.status === 'ACTIVE')
    .map((p) => {
      const generic = new Set(tokens(p.category ?? ''));
      const distinctive = tokens(p.title).filter((t) => t.length >= 3 && !generic.has(t));
      return { product: p, hits: distinctive.filter((t) => words.has(t)).length };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  const best = scored.filter((s) => s.hits === scored[0]?.hits).map((s) => s.product);
  const q = norm(query);
  const variantIn = (p: ProductRecord) =>
    variants.find((v) => v.productId === p.productId && q.includes(norm(v.title))) ?? null;
  return { matches: best, variantIn };
}

export function createToolHandlers(deps: ToolDeps): ToolHandlers {
  const catalog = async (brandId: string) => {
    const [brand, products, variants] = await Promise.all([
      deps.brands.getById(brandId),
      deps.products.listProducts(brandId),
      deps.products.listVariants(brandId),
    ]);
    return { settings: brand?.settings ?? {}, brandName: brand?.name ?? '', products, variants };
  };

  const variantView = async (brandId: string, variantId: string): Promise<VariantView | null> => {
    const { settings, products, variants } = await catalog(brandId);
    const variant = variants.find((v) => v.variantId === variantId);
    const product = variant && products.find((p) => p.productId === variant.productId);
    if (!variant || !product) return null;
    return {
      variant_id: variant.variantId,
      product_id: product.productId,
      product_title: product.title,
      variant_title: variant.title,
      sku: variant.sku,
      price: variant.price,
      currency: variant.currency,
      online_url: onlineProductUrl(settings, product.productId),
    };
  };

  const storeInfo = (s: StoreRecord) => ({
    store_id: s.storeId,
    store_name: s.storeName,
    address: s.address,
    city: s.city,
    latitude: s.latitude,
    longitude: s.longitude,
    timezone: s.storeHours?.timezone ?? null,
  });

  const reservationOutput = async (
    brandId: string,
    status: ReservationToolOutput['status'],
    reason: string | null,
    r: {
      reservationId: string;
      status: string;
      storeId: string;
      variantId: string;
      quantity: number;
      pickupCode: string;
      createdAt: string;
      expiresAt: string;
      customerEta: string | null;
    } | null,
    storeId: string | null,
    variantId: string | null,
  ): Promise<ReservationToolOutput> => {
    const store = storeId ? await deps.stores.get(brandId, storeId) : null;
    return {
      status,
      reason,
      reservation: r
        ? {
            reservation_id: r.reservationId,
            status: r.status,
            store_id: r.storeId,
            variant_id: r.variantId,
            quantity: r.quantity,
            pickup_code: r.pickupCode,
            created_at: r.createdAt,
            expires_at: r.expiresAt,
            customer_eta: r.customerEta,
          }
        : null,
      store: store ? storeInfo(store) : null,
      variant: variantId ? await variantView(brandId, variantId) : null,
    };
  };

  return {
    async get_product_context(input: ToolInput<'get_product_context'>, scope: ToolScope) {
      const { settings, products, variants } = await catalog(scope.brandId);
      let product: ProductRecord | null = null;
      let variantId: string | null = null;
      let candidates: ProductRecord[] = [];
      if (input.variant_id) {
        const v = variants.find((x) => x.variantId === input.variant_id);
        product = (v && products.find((p) => p.productId === v.productId)) ?? null;
        variantId = v?.variantId ?? null;
      } else if (input.product_id) {
        product = products.find((p) => p.productId === input.product_id) ?? null;
      } else if (input.query) {
        const { matches, variantIn } = matchCatalog(input.query, products, variants);
        if (matches.length === 1) {
          product = matches[0]!;
          variantId = variantIn(product)?.variantId ?? null;
        } else candidates = matches;
      }
      const output: ProductContextOutput = product
        ? {
            status: 'FOUND',
            product: sheetOf(product, variants, settings),
            variant_id: variantId,
            alternatives: alternativesOf(product, products).map((p) => sheetOf(p, variants, settings)),
            candidates: [],
          }
        : {
            status: candidates.length > 1 ? 'AMBIGUOUS' : 'NOT_FOUND',
            product: null,
            variant_id: null,
            alternatives: [],
            candidates: candidates.map((p) => ({ product_id: p.productId, title: p.title })),
          };
      return ok(output);
    },

    async get_brand_policy(_input: ToolInput<'get_brand_policy'>, scope: ToolScope) {
      const brand = await deps.brands.getById(scope.brandId);
      const settings = brand?.settings ?? {};
      const policy = resolveReservationPolicy(settings);
      const output: BrandPolicyOutput = {
        reservations_enabled: policy.reservationsEnabled,
        hold_minutes: policy.holdMinutes,
        max_quantity_per_reservation: policy.maxQuantityPerReservation,
        handoff_enabled: resolveMessagingSettings(settings, brand?.name ?? '').handoffEnabled,
        online_purchase_available: onlineProductUrl(settings, 'x') !== null,
        payment: 'PAY_AT_STORE',
      };
      return ok(output);
    },

    async get_customer_history(_input: ToolInput<'get_customer_history'>, scope: ToolScope) {
      const [rows, stores] = await Promise.all([
        deps.reservations.listForCustomer(scope.brandId, scope.customerId),
        deps.stores.list(scope.brandId),
      ]);
      const names = new Map(stores.map((s) => [s.storeId, s.storeName]));
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
      const output: CustomerHistoryOutput = {
        active_reservations: rows
          .filter((r) => ACTIVE_RESERVATION_STATUSES.includes(r.status))
          .map((r) => ({
            reservation_id: r.reservationId,
            store_id: r.storeId,
            store_name: names.get(r.storeId) ?? r.storeId,
            variant_id: r.variantId,
            status: r.status,
            expires_at: r.expiresAt,
          })),
        reservation_counts: counts,
      };
      return ok(output);
    },

    async find_nearby_stores(input: ToolInput<'find_nearby_stores'>, scope: ToolScope) {
      const now = deps.now();
      const radiusKm = input.radius_km ?? DEFAULT_RADIUS_KM;
      const excludedIds = input.skip_stores ?? [];
      const base: NearbyStoresOutput = {
        status: 'OK',
        variant: await variantView(scope.brandId, input.variant_id),
        origin: null,
        origin_point: null,
        radius_km: radiusKm,
        skipped_stores: excludedIds,
        eligible: [],
        excluded: [],
        ambiguous_areas: [],
      };
      if (!base.variant) return ok({ ...base, status: 'UNKNOWN_VARIANT' });
      const stores = await deps.stores.list(scope.brandId);

      // Location: given coordinates → an area matching one store locality → the customer's last location.
      let origin: GeoPoint | null = null;
      if (input.latitude !== undefined && input.longitude !== undefined) {
        origin = { latitude: roundCoordinate(input.latitude), longitude: roundCoordinate(input.longitude) };
        base.origin = { source: 'SHARED', approximate: false, locality: null };
      } else if (input.area) {
        const resolved = resolveLocality(input.area, stores);
        if (resolved.status === 'AMBIGUOUS')
          return ok({ ...base, status: 'AMBIGUOUS_AREA', ambiguous_areas: resolved.localities });
        if (resolved.status === 'MATCH') {
          origin = resolved.origin;
          base.origin = { source: 'LOCALITY', approximate: true, locality: resolved.locality };
        }
      }
      if (!origin) {
        const customer = await deps.customers.get(scope.brandId, scope.customerId);
        const last = customer?.lastLocation;
        if (!last) return ok({ ...base, status: 'LOCATION_REQUIRED' });
        origin = { latitude: last.latitude, longitude: last.longitude };
        base.origin = { source: last.source, approximate: last.source === 'LOCALITY', locality: last.locality };
      }
      base.origin_point = origin;

      const stock = await deps.inventory.listByVariant(scope.brandId, input.variant_id);
      const freshnessHours = resolveFreshnessHours((await deps.brands.getById(scope.brandId))?.settings ?? {});
      const byStore = new Map(stock.map((row) => [row.storeId, row]));
      const candidates = stores.filter((s) => !excludedIds.includes(s.storeId));
      const result = findEligibleStores({
        origin,
        radiusKm,
        now,
        candidates: candidates.map((store) => ({ store, inventory: byStore.get(store.storeId) ?? null })),
      });
      const byId = new Map(stores.map((s) => [s.storeId, s]));
      const round1 = (km: number) => Math.round(km * 10) / 10;
      base.eligible = result.eligible.map((e): StoreOption => {
        const s = byId.get(e.storeId)!;
        return {
          store_id: s.storeId,
          store_name: s.storeName,
          locality: primaryLocality(s),
          address: s.address,
          city: s.city,
          latitude: s.latitude!,
          longitude: s.longitude!,
          timezone: s.storeHours?.timezone ?? 'UTC',
          distance_km: round1(e.distanceKm),
          open_until: closingTimeToday(s.storeHours, now),
          available_quantity: e.availableQuantity,
          offline_price: byStore.get(s.storeId)?.offlinePrice ?? null,
          stock_updated_at: byStore.get(s.storeId)?.lastUpdatedAt ?? null,
          stale: isStockStale(byStore.get(s.storeId)?.lastUpdatedAt ?? null, now, freshnessHours),
        };
      });
      base.excluded = result.excluded
        .map((x): ExcludedStoreView => {
          const s = byId.get(x.storeId)!;
          return {
            store_id: s.storeId,
            store_name: s.storeName,
            locality: primaryLocality(s),
            reason: x.reason,
            distance_km: x.distanceKm === null ? null : round1(x.distanceKm),
            timezone: s.storeHours?.timezone ?? null,
          };
        })
        .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
      return ok(base);
    },

    async check_store_inventory(input: ToolInput<'check_store_inventory'>, scope: ToolScope) {
      const store = await deps.stores.get(scope.brandId, input.store_id);
      const row = (await deps.inventory.listByStore(scope.brandId, input.store_id)).find(
        (r) => r.variantId === input.variant_id,
      );
      const available = row ? availableQuantity(row.quantity, row.reservedQuantity) : 0;
      const output: StoreInventoryOutput = {
        status: store ? 'OK' : 'UNKNOWN_STORE',
        store_id: input.store_id,
        variant_id: input.variant_id,
        available_quantity: store ? available : 0,
        availability_status: row ? deriveAvailabilityStatus(row.quantity, row.reservedQuantity) : 'OUT_OF_STOCK',
      };
      return ok(output);
    },

    async get_store_hours(input: ToolInput<'get_store_hours'>, scope: ToolScope) {
      const store = await deps.stores.get(scope.brandId, input.store_id);
      const now = deps.now();
      const hours = store?.storeHours ?? null;
      const day = hours?.timezone
        ? new Intl.DateTimeFormat('en-US', { timeZone: hours.timezone, weekday: 'long' }).format(now).toLowerCase()
        : null;
      const output: StoreHoursOutput = {
        status: store ? 'OK' : 'UNKNOWN_STORE',
        store_id: input.store_id,
        timezone: hours?.timezone ?? null,
        open_now: isOpenNow(hours, now),
        open_until: closingTimeToday(hours, now),
        today: day && hours ? (hours[day] ?? '') || null : null,
      };
      return ok(output);
    },

    async create_reservation(input: ToolInput<'create_reservation'>, scope: ToolScope) {
      const result = await deps.reservations.create({
        brandId: scope.brandId,
        customerId: scope.customerId,
        storeId: input.store_id,
        variantId: input.variant_id,
        quantity: input.quantity,
        idempotencyKey: scope.recommendationId,
        aiRecommendationId: scope.recommendationId,
        customerEta: input.customer_eta ?? null,
      });
      if (result.status === 'REJECTED') {
        return {
          status: 'FAILED',
          reasonCode: result.reason,
          output: await reservationOutput(
            scope.brandId,
            'REJECTED',
            result.reason,
            null,
            input.store_id,
            input.variant_id,
          ),
        };
      }
      return ok(
        await reservationOutput(
          scope.brandId,
          result.status,
          null,
          result.reservation,
          input.store_id,
          input.variant_id,
        ),
      );
    },

    async cancel_reservation(input: ToolInput<'cancel_reservation'>, scope: ToolScope) {
      const result = await deps.reservations.cancelByCustomer(scope.brandId, scope.customerId, input.reservation_id);
      if (result.status === 'NOT_FOUND') {
        return {
          status: 'FAILED',
          reasonCode: 'NOT_FOUND',
          output: await reservationOutput(scope.brandId, 'NOT_FOUND', 'NOT_FOUND', null, null, null),
        };
      }
      const r = result.reservation;
      if (result.status === 'REJECTED') {
        return {
          status: 'FAILED',
          reasonCode: 'INVALID_TRANSITION',
          output: await reservationOutput(
            scope.brandId,
            'INVALID_TRANSITION',
            'INVALID_TRANSITION',
            r,
            r.storeId,
            r.variantId,
          ),
        };
      }
      return ok(await reservationOutput(scope.brandId, 'CANCELLED', null, r, r.storeId, r.variantId));
    },

    async request_human_handoff(input: ToolInput<'request_human_handoff'>, scope: ToolScope) {
      const at = deps.now().toISOString();
      await deps.conversations.update(scope.brandId, scope.conversationId, {
        humanHandoff: true,
        handoffAt: at,
        updatedAt: at,
      });
      await deps.events.record({
        brandId: scope.brandId,
        customerId: scope.customerId,
        eventType: 'HUMAN_HANDOFF',
        source: 'QWIKSPOT',
        entityReference: scope.conversationId,
        payload: { conversation_id: scope.conversationId, reason: input.reason.slice(0, 80) },
        idempotencyKey: `HUMAN_HANDOFF:${scope.recommendationId}`,
        at,
      });
      await deps.events.audit(scope.brandId, {
        action: 'HUMAN_HANDOFF_STARTED',
        targetType: 'CONVERSATION',
        targetId: scope.conversationId,
      });
      return ok({ human_handoff: true });
    },

    async record_customer_intent(input: ToolInput<'record_customer_intent'>, scope: ToolScope) {
      if (!scope.intentId || !CONVERSATIONAL_INTENT_TYPES.includes(input.intent_type)) {
        return {
          status: 'FAILED',
          reasonCode: 'NOT_REFINABLE',
          output: { intent_id: scope.intentId, intent_type: input.intent_type, changed: false },
        };
      }
      let changed = false;
      await deps.intents.update(scope.brandId, scope.intentId, (current) => {
        // Only the conversation's own customer's intent; the type only, never the stage.
        if (!current || current.customerId !== scope.customerId || current.type === input.intent_type) return null;
        changed = INTENT_TYPES.includes(input.intent_type);
        return { ...current, type: input.intent_type, updatedAt: deps.now().toISOString() };
      });
      return ok({ intent_id: scope.intentId, intent_type: input.intent_type, changed });
    },
  } as unknown as ToolHandlers;
}
