/**
 * The docs/08 §7.1 fixture on the in-memory world: brand_A with reservations and handoff
 * enabled, stores A–E around the customer's location, variant V1 (+ comparable V2), and
 * brand_B for leakage checks. The clock is fixed on a Wednesday, 12:00 in Mumbai.
 */
import request from 'supertest';
import type { AgentRuntime } from '../src/ports/agent.js';
import { bearer, buildTestWorld, TEST_ORIGIN } from './helpers.js';

export const SCENARIO_NOW = new Date('2026-10-07T06:30:00.000Z'); // Wed 12:00 Asia/Kolkata
export const ORIGIN = { latitude: 19.0, longitude: 72.8 };
export const V1 = 'var_2001'; // Vitamin C Glow Serum 30 ml
export const V1_50 = 'var_2002'; // Vitamin C Glow Serum 50 ml
export const V2 = 'var_2003'; // Niacinamide Clarifying Serum 30 ml (comparable)
const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };

const OPEN = {
  timezone: 'Asia/Kolkata',
  monday: '10:00-21:00',
  tuesday: '10:00-21:00',
  wednesday: '10:00-21:00',
  thursday: '10:00-21:00',
  friday: '10:00-21:00',
  saturday: '10:00-21:00',
  sunday: '10:00-21:00',
};
const CLOSED = {
  timezone: 'Asia/Kolkata',
  monday: '',
  tuesday: '',
  wednesday: '',
  thursday: '',
  friday: '',
  saturday: '',
  sunday: '',
};

/** Distance north of ORIGIN in km → latitude (same longitude). */
const north = (km: number) => Math.round((ORIGIN.latitude + km / 111.195) * 1e6) / 1e6;

export const SCENARIO_STORES = [
  { id: 'sc_A', name: 'Colaba Store', area: 'Colaba Causeway, Colaba', km: 2, hours: OPEN, v1: 8, v2: 5 },
  { id: 'sc_B', name: 'Worli Store', area: 'Annie Besant Road, Worli', km: 6, hours: OPEN, v1: 3, v2: 2 },
  { id: 'sc_C', name: 'Fort Store', area: 'Hutatma Chowk, Fort', km: 1, hours: CLOSED, v1: 5, v2: 5 },
  { id: 'sc_D', name: 'Marine Lines Store', area: 'Marine Drive, Marine Lines', km: 3, hours: OPEN, v1: 0, v2: 0 },
  { id: 'sc_E', name: 'Tardeo Store', area: 'Tardeo Road, Tardeo', km: 4, hours: OPEN, v1: 1, v2: 0 },
];

export type ScenarioWorld = Awaited<ReturnType<typeof buildScenarioWorld>>;

export async function buildScenarioWorld(
  options: {
    agent?: AgentRuntime;
    aiBudgetMs?: number;
    now?: () => Date;
    overrides?: Partial<Record<string, { km?: number; v1?: number; hours?: Record<string, string> }>>;
    reservationsEnabled?: boolean;
    handoffEnabled?: boolean;
    simulatorProvider?: import('../src/ports/messaging.js').MessagingProvider;
    logger?: import('../src/lib/logger.js').Logger;
  } = {},
) {
  let now = SCENARIO_NOW;
  const clock = options.now ?? (() => now);
  const world = buildTestWorld({
    now: clock,
    agent: options.agent,
    aiBudgetMs: options.aiBudgetMs,
    simulatorProvider: options.simulatorProvider,
    logger: options.logger,
  });
  await world.commerceSync.sync('brand_A', SYSTEM);
  await world.commerceSync.sync('brand_B', SYSTEM);

  const brand = world.brands.brands.find((b) => b.brandId === 'brand_A')!;
  brand.settings = {
    ...brand.settings,
    reservation_policy: {
      reservations_enabled: options.reservationsEnabled ?? true,
      hold_minutes: 120,
      max_quantity_per_reservation: 2,
    },
    human_handoff_rules: { enabled: options.handoffEnabled ?? true },
    online_store: { product_url_template: 'http://shop.test/products/{product_id}' },
  };

  const variants = await world.products.listVariants('brand_A');
  const canonical = (variantId: string) => variants.find((v) => v.variantId === variantId)!;
  const stores = SCENARIO_STORES.map((s) => ({ ...s, ...(options.overrides?.[s.id] ?? {}) }));
  await world.stores.upsertFromImport(
    'brand_A',
    stores.map((s) => ({
      storeId: s.id,
      storeName: s.name,
      city: 'Mumbai',
      address: `${s.area}, Mumbai 400001`,
      latitude: north(s.km),
      longitude: ORIGIN.longitude,
      storeHours: s.hours,
      storeStatus: 'ACTIVE' as const,
      reservationAvailable: true,
      pickupAvailable: true,
    })),
  );
  // M6: sc_A and sc_B belong to retailer rtl_A, each with its own Retail Admin (one store each).
  for (const [storeId, userId] of [
    ['sc_A', 'radmin_scA'],
    ['sc_B', 'radmin_scB'],
  ] as const) {
    const record = world.stores.stores.find((x) => x.brandId === 'brand_A' && x.storeId === storeId)!;
    record.retailerId = 'rtl_A';
    record.retailAdminUserId = userId;
    world.users.users.push({
      userId,
      role: 'RETAIL_ADMIN',
      brandId: 'brand_A',
      retailerId: 'rtl_A',
      storeId,
      email: `${userId}@example.test`,
      status: 'ACTIVE',
    });
  }
  const rows = stores.flatMap((s) =>
    [
      [V1, s.v1],
      [V2, s.v2],
      [V1_50, 0],
    ].map(([variantId, quantity]) => {
      const v = canonical(variantId as string);
      return {
        storeId: s.id,
        sku: v.sku,
        canonicalSku: v.canonicalSku!,
        variantId: v.variantId,
        quantity: quantity as number,
        offlinePrice: v.price,
      };
    }),
  );
  await world.inventory.upsertStock('brand_A', rows, () => 'IN_STOCK');
  for (const row of world.inventory.rows) row.availabilityStatus = row.quantity > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';

  let n = 0;
  const send = (ref: string, content: Record<string, unknown>, id = `cm_${++n}`) =>
    request(world.app)
      .post('/api/channels/simulator/messages')
      .set('Authorization', bearer('admin_a'))
      .send({ simulator_customer_ref: ref, client_message_id: id, content });

  return {
    world,
    setNow: (d: Date) => (now = d),
    advanceMinutes: (m: number) => (now = new Date(now.getTime() + m * 60_000)),
    say: (ref: string, text: string, id?: string) => send(ref, { type: 'TEXT', text }, id),
    share: (ref: string, point = ORIGIN) => send(ref, { type: 'LOCATION', ...point }),
    tap: (ref: string, optionId: string) => send(ref, { type: 'INTERACTIVE_REPLY', option_id: optionId }),
    get: (path: string, user = 'admin_a') => request(world.app).get(path).set('Authorization', bearer(user)),
    stock: (storeId: string, variantId = V1) =>
      world.inventory.rows.find((r) => r.brandId === 'brand_A' && r.storeId === storeId && r.variantId === variantId)!,
    /** "Need it today?" on the storefront for V1, then the first chat message carries the token. */
    startFromStore: async (ref: string, text: string, gid = 'gid://shopify/ProductVariant/2001') => {
      const click = await request(world.app)
        .post('/api/intents')
        .set('Origin', TEST_ORIGIN)
        .send({
          brand_id: 'brand_A',
          web_session_id: `ws_${ref}_0000000001`,
          visitor_id: `vis_${ref}_000000001`,
          client_event_id: `ce_${++n}`,
          event_type: 'WHATSAPP_CLICK',
          entry: 'STORE_NEED',
          shopify_variant_id: gid,
        });
      return send(ref, { type: 'TEXT', text: `${click.body.whatsapp.prefilled_text} ${text}` });
    },
    lastRecommendation: () => world.recommendations.recommendations.at(-1)!,
  };
}
