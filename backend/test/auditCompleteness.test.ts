/**
 * Audit completeness (docs/07 §11, M7): every mutating route writes at least one
 * AuditEvent with an actor, the brand scope, an action and a result — and no PII.
 * A static scan of src/routes keeps the table honest: a new mutating route without an
 * entry here fails this test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, buildTestWorld, TEST_ORIGIN } from './helpers.js';
import { buildScenarioWorld, type ScenarioWorld } from './scenarioWorld.js';
import { FakeShopify, signedCallback, TEST_SHOP, webhookHmac } from './shopifyFakes.js';

/** L2-Shopify routes run in their own COMMERCE_PROVIDER=shopify world; their new events land in ctx. */
async function inShopifyWorld(
  ctx: Record<string, string>,
  name: string,
  act: (w: ReturnType<typeof buildTestWorld>) => Promise<request.Response>,
) {
  const w = buildTestWorld({ shopify: new FakeShopify() });
  const connect = await request(w.app)
    .post('/api/integrations/shopify/connect')
    .set('Authorization', bearer('admin_a'))
    .send({ shop: TEST_SHOP });
  const state = new URL(connect.body.authorize_url).searchParams.get('state')!;
  await request(w.app)
    .get('/api/integrations/shopify/callback')
    .query(signedCallback({ code: 'c', shop: TEST_SHOP, state, timestamp: '1' }));
  const before = w.audit.brandEvents.length;
  const res = name.endsWith('/shopify/connect') ? connect : await act(w);
  ctx[`own:${name}`] = JSON.stringify(
    name.endsWith('/shopify/connect') ? w.audit.brandEvents : w.audit.brandEvents.slice(before),
  );
  return res;
}

const ROUTES_DIR = fileURLToPath(new URL('../src/routes', import.meta.url));

/** Every `router.post|patch|put|delete('<path>'` in src/routes, as "file METHOD path". */
function declaredMutatingRoutes(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((file) =>
      [...readFileSync(join(ROUTES_DIR, file), 'utf8').matchAll(/router\.(post|patch|put|delete)\(\s*'([^']+)'/g)].map(
        (m) => `${file} ${m[1]!.toUpperCase()} ${m[2]}`,
      ),
    )
    .sort();
}

/**
 * Not audited by design:
 * - the local upload target only carries bytes for LocalFileStorageProvider (in gcp the
 *   browser uploads straight to Cloud Storage); the import's create and process are audited.
 */
const EXEMPT: Record<string, string> = {
  'localFiles.ts PUT /uploads/:uploadId': 'storage transport only; RETAIL_IMPORT_CREATED / _PROCESSED are audited',
};

type Step = (s: ScenarioWorld, ctx: Record<string, string>) => Promise<request.Response>;
const as = (s: ScenarioWorld, user: string) => ({
  post: (p: string, body: object = {}) => request(s.world.app).post(p).set('Authorization', bearer(user)).send(body),
  patch: (p: string, body: object = {}) => request(s.world.app).patch(p).set('Authorization', bearer(user)).send(body),
});

const ROUTES: [string, Step][] = [
  [
    'intents.ts POST /intents',
    (s) =>
      request(s.world.app).post('/api/intents').set('Origin', TEST_ORIGIN).send({
        brand_id: 'brand_A',
        web_session_id: 'ws_audit_0000001',
        visitor_id: 'vis_audit_000001',
        client_event_id: 'ce_a1',
        event_type: 'STOREFRONT_VISIT',
      }),
  ],
  ['conversations.ts POST /messages', (s) => s.say('aud1', 'Is this good for oily skin?')],
  ['conversations.ts POST /follow-ups/process-due', (s) => as(s, 'admin_a').post('/api/brand/follow-ups/process-due')],
  [
    'conversations.ts POST /conversations/:conversationId/replies',
    async (s, ctx) => {
      ctx.conv = (await s.say('aud2', 'I want to talk to a person')).body.conversation_id;
      s.world.audit.brandEvents.length = 0;
      return as(s, 'admin_a').post(`/api/brand/conversations/${ctx.conv}/replies`, { text: 'Hello from the team' });
    },
  ],
  [
    'conversations.ts POST /conversations/:conversationId/resolve',
    (s, ctx) => as(s, 'admin_a').post(`/api/brand/conversations/${ctx.conv}/resolve`),
  ],
  [
    'demoStorefront.ts POST /shopper-sign-in',
    (s) =>
      request(s.world.app).post('/api/demo-storefront/shopper-sign-in').set('Origin', TEST_ORIGIN).send({
        brand_id: 'brand_A',
        shopper_id: 'gid://shopify/Customer/3002',
        web_session_id: 'ws_audit_0000002',
        visitor_id: 'vis_audit_000002',
      }),
  ],
  [
    'shopper.ts POST /session',
    async (s, ctx) => {
      const res = await request(s.world.app)
        .post('/api/shopper/session')
        .set('Origin', TEST_ORIGIN)
        .send({ brand_id: 'brand_A' });
      ctx.shopperSession = res.body.session_token;
      return res;
    },
  ],
  [
    'shopper.ts POST /messages',
    (s, ctx) =>
      request(s.world.app)
        .post('/api/shopper/messages')
        .set('Origin', TEST_ORIGIN)
        .set('X-Qwikspot-Shopper-Session', ctx.shopperSession!)
        .send({
          client_message_id: 'cm_audit_shopper_1',
          content: { type: 'TEXT', text: 'Is this good for oily skin?' },
        }),
  ],
  [
    'demoStorefront.ts POST /orders',
    (s) =>
      request(s.world.app).post('/api/demo-storefront/orders').set('Origin', TEST_ORIGIN).send({
        brand_id: 'brand_A',
        web_session_id: 'ws_audit_0000002',
        shopify_variant_id: 'gid://shopify/ProductVariant/2001',
      }),
  ],
  [
    'reservations.ts PATCH /:reservationId',
    async (s) => {
      await s.startFromStore('aud3', 'hi');
      await s.share('aud3');
      const id = (await s.tap('aud3', 'hold:sc_A')).body.decision.executed_action.reservation_id;
      s.world.audit.brandEvents.length = 0;
      return as(s, 'radmin_scA').patch(`/api/reservations/${id}`, {
        status: 'CONFIRMED',
        expected_current_status: 'PENDING',
      });
    },
  ],
  ['catalog.ts POST /shopify/sync', (s) => as(s, 'admin_a').post('/api/integrations/shopify/sync')],
  ['brandAdmin.ts POST /retailers', (s) => as(s, 'admin_a').post('/api/brand/retailers', { name: 'Audit Retail' })],
  [
    'brandAdmin.ts POST /stores/:storeId/admins',
    (s) => as(s, 'admin_a').post('/api/brand/stores/store_C/admins', { email: 'new-admin@example.test' }),
  ],
  [
    'brandAdmin.ts PATCH /stores/:storeId',
    (s) => as(s, 'admin_a').patch('/api/brand/stores/store_free', { retailer_id: 'rtl_A' }),
  ],
  [
    'retailImports.ts POST /',
    async (s, ctx) => {
      const res = await as(s, 'admin_a').post('/api/brand/retail-imports', { file_name: 'audit.csv' });
      ctx.importId = res.body.import.import_id;
      ctx.fileKey = res.body.upload.url;
      return res;
    },
  ],
  [
    'retailImports.ts POST /:importId/process',
    async (s, ctx) => {
      await request(s.world.app)
        .put(ctx.fileKey!)
        .set('Authorization', bearer('admin_a'))
        .set('Content-Type', 'text/csv')
        .send('store_id,store_name\nst_x,X\n');
      return as(s, 'admin_a').post(`/api/brand/retail-imports/${ctx.importId}/process`);
    },
  ],
  [
    'platform.ts POST /brands',
    async (s, ctx) => {
      const res = await as(s, 'platform').post('/api/platform/brands', { name: 'Audit Brand' });
      ctx.brand = res.body.brand_id;
      return res;
    },
  ],
  [
    'platform.ts PATCH /brands/:brandId',
    (s, ctx) =>
      as(s, 'platform').patch(`/api/platform/brands/${ctx.brand}`, { status: 'SUSPENDED', reason: 'audit test' }),
  ],
  [
    'platform.ts POST /brands/:brandId/admins',
    (s) => as(s, 'platform').post('/api/platform/brands/brand_C/admins', { email: 'brand-c-admin@example.test' }),
  ],
  [
    'shopify.ts POST /shopify/connect',
    (_s, ctx) => inShopifyWorld(ctx, 'shopify.ts POST /shopify/connect', async (r) => r as never),
  ],
  [
    'shopify.ts POST /shopify/disconnect',
    (_s, ctx) =>
      inShopifyWorld(ctx, 'shopify.ts POST /shopify/disconnect', (w) =>
        request(w.app).post('/api/integrations/shopify/disconnect').set('Authorization', bearer('admin_a')),
      ),
  ],
  [
    'shopify.ts POST /webhooks/shopify',
    (_s, ctx) =>
      inShopifyWorld(ctx, 'shopify.ts POST /webhooks/shopify', (w) => {
        const raw = JSON.stringify({ id: 1, admin_graphql_api_id: 'gid://shopify/Order/1', line_items: [] });
        return request(w.app)
          .post('/api/webhooks/shopify')
          .set('Content-Type', 'application/json')
          .set('X-Shopify-Topic', 'orders/create')
          .set('X-Shopify-Shop-Domain', TEST_SHOP)
          .set('X-Shopify-Event-Id', 'evt-audit-1')
          .set('X-Shopify-Hmac-Sha256', webhookHmac(raw))
          .send(raw);
      }),
  ],
  [
    'demo.ts POST /demo/reset',
    async (_s, ctx) => {
      // Its own world: Reset demo exists only with DEMO_MODE on and an allowlisted brand.
      const w = buildTestWorld({ demo: { enabled: true, brandIds: ['brand_A'], holdMinutes: 20, logins: [] } });
      const res = await request(w.app).post('/api/brand/demo/reset').set('Authorization', bearer('admin_a'));
      ctx.resetAudit = JSON.stringify(w.audit.brandEvents.filter((e) => e.action === 'DEMO_RESET'));
      return res;
    },
  ],
];

describe('audit completeness (docs/07 §11)', () => {
  it('every mutating route in src/routes is covered by this table (or exempt with a reason)', () => {
    const covered = [...ROUTES.map(([k]) => k), ...Object.keys(EXEMPT)].sort();
    expect(declaredMutatingRoutes()).toEqual(covered);
  });

  let s: ScenarioWorld;
  const ctx: Record<string, string> = {};
  beforeAll(async () => {
    s = await buildScenarioWorld();
  });

  it.each(ROUTES)('%s writes an AuditEvent with actor, scope, action and result — and no PII', async (name, step) => {
    const before = s.world.audit.brandEvents.length;
    const platformBefore = s.world.audit.platformEvents.length;
    const res = await step(s, ctx);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    const added = s.world.audit.brandEvents.slice(s.world.audit.brandEvents.length > before ? before : 0);
    const addedPlatform = s.world.audit.platformEvents.slice(platformBefore);
    // Reset demo runs in its own DEMO_MODE world; its event is checked there.
    if (name === 'demo.ts POST /demo/reset') {
      expect(JSON.parse(ctx.resetAudit!)).toEqual([
        expect.objectContaining({ actorType: 'USER', actorId: 'admin_a', brandId: 'brand_A', result: 'SUCCESS' }),
      ]);
      return;
    }
    const own = ctx[`own:${name}`];
    const events: typeof added = own ? JSON.parse(own) : added;
    expect(events.length + (own ? 0 : addedPlatform.length)).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.brandId).toMatch(/^[\w-]+$/);
      expect(e.actorType).toMatch(/^(USER|SYSTEM|AGENT|CUSTOMER|PLATFORM_ADMIN)$/);
      expect(e.actorId).toBeTruthy();
      expect(e.action).toMatch(/^[A-Z_]+$/);
      expect(['SUCCESS', 'DENIED', 'FAILED']).toContain(e.result);
      const text = JSON.stringify(e);
      expect(text).not.toMatch(/@|\+91|\b\d{10}\b|oily skin|talk to a person|Hello from the team/);
    }
  });
});
