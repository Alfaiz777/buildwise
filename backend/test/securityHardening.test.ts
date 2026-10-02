/**
 * M7 security & reliability hardening (docs/07 §15, §17, §19; docs/08 §4.1, §10):
 * HTTP headers, CORS, error envelopes, rate limits on every public / customer-facing
 * route, and the gcp execution-profile refusals.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createProviders, profileFeatures, AdapterNotAvailableError } from '../src/composition/container.js';
import { loadConfig } from '../src/config/env.js';
import { bearer, buildTestWorld, TEST_ORIGIN } from './helpers.js';
import { GCP_REQUIRED_FAKE } from './config.test.js';

const GCP = {
  QWIKSPOT_PROFILE: 'gcp',
  GOOGLE_CLOUD_PROJECT: 'qwikspot-test',
  NODE_ENV: 'production',
  ...GCP_REQUIRED_FAKE,
};

describe('HTTP hardening', () => {
  const { app } = buildTestWorld({ corsAllowedOrigins: ['https://console.example.test'] });

  it('security headers on every response (helmet), no x-powered-by', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS: only the configured console origin is echoed; anything else gets no CORS headers', async () => {
    const ok = await request(app).get('/api/health').set('Origin', 'https://console.example.test');
    expect(ok.headers['access-control-allow-origin']).toBe('https://console.example.test');
    const evil = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('the storefront endpoint accepts only the brand’s allowlisted origin', async () => {
    const body = {
      brand_id: 'brand_A',
      web_session_id: 'ws_harden_0000001',
      visitor_id: 'vis_harden_000001',
      client_event_id: 'ce_h1',
      event_type: 'STOREFRONT_VISIT',
    };
    expect((await request(app).post('/api/intents').set('Origin', TEST_ORIGIN).send(body)).status).toBe(202);
    expect(
      (
        await request(app)
          .post('/api/intents')
          .set('Origin', 'https://evil.example')
          .send({ ...body, client_event_id: 'ce_h2' })
      ).status,
    ).toBe(403);
  });

  it('one error envelope everywhere (404, 401, 400, 413) and never a stack trace', async () => {
    const responses = [
      await request(app).get('/nope'),
      await request(app).get('/api/brand/conversations'),
      await request(app).post('/api/intents').set('Content-Type', 'application/json').send('{bad'),
      await request(app)
        .post('/api/intents')
        .send({ blob: 'x'.repeat(120_000) }),
    ];
    expect(responses.map((r) => r.status)).toEqual([404, 401, 400, 413]);
    for (const r of responses) {
      expect(Object.keys(r.body)).toEqual(['error']);
      expect(Object.keys(r.body.error).sort()).toEqual(['code', 'message', 'request_id', 'retryable']);
      expect(JSON.stringify(r.body)).not.toMatch(/stack|at .*\.ts:\d+|node_modules/);
    }
  });
});

describe('rate limits on every public and customer-facing route (docs/07 §17) → 429', () => {
  const hammer = async (n: number, make: () => request.Test) => {
    const statuses: number[] = [];
    for (let i = 0; i < n; i++) statuses.push((await make()).status);
    return statuses;
  };

  it('POST /api/intents: 60/min per IP', async () => {
    const { app } = buildTestWorld();
    let n = 0;
    const statuses = await hammer(61, () =>
      request(app)
        .post('/api/intents')
        .set('Origin', TEST_ORIGIN)
        .send({
          brand_id: 'brand_A',
          web_session_id: 'ws_rate_00000001',
          visitor_id: 'vis_rate_0000001',
          client_event_id: `ce_${++n}`,
          event_type: 'STOREFRONT_VISIT',
        }),
    );
    expect(statuses.at(-1)).toBe(429);
  });

  it('simulator: 30/min per Brand Admin', async () => {
    const { app } = buildTestWorld();
    let n = 0;
    const statuses = await hammer(31, () =>
      request(app)
        .post('/api/channels/simulator/messages')
        .set('Authorization', bearer('admin_a'))
        .send({
          simulator_customer_ref: 'rate',
          client_message_id: `cm_${++n}`,
          content: { type: 'TEXT', text: 'hello' },
        }),
    );
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('demo storefront (local only): 120/min per IP', async () => {
    const { app } = buildTestWorld();
    const statuses = await hammer(121, () =>
      request(app).get('/api/demo-storefront/shoppers').set('Origin', TEST_ORIGIN),
    );
    expect(statuses.at(-1)).toBe(429);
  });

  it('demo login panel: 30/min per IP', async () => {
    const { app } = buildTestWorld();
    const statuses = await hammer(31, () => request(app).get('/api/demo/config'));
    expect(statuses[29]).toBe(200);
    expect(statuses[30]).toBe(429);
  });
});

describe('DEMO_MODE never ships passwords when off', () => {
  it('off → { demo_mode: false } only; on → the configured logins', async () => {
    const off = buildTestWorld();
    expect((await request(off.app).get('/api/demo/config')).body).toEqual({ demo_mode: false });
    const on = buildTestWorld({ demo: loadConfig({ DEMO_MODE: 'true' }).demo });
    const res = await request(on.app).get('/api/demo/config');
    expect(res.body.demo_mode).toBe(true);
    expect(res.body.logins.map((l: { email: string }) => l.email)).toContain('admin@demo-brand.test');
  });
});

describe('execution-profile security (docs/07 §19, docs/08 §4.1)', () => {
  it.each([
    ['COMMERCE_PROVIDER', 'mock'],
    ['AGENT_RUNTIME', 'mock'],
    ['FILE_STORAGE', 'local'],
    ['EVENT_SINK', 'local'],
  ])('gcp refuses %s=%s', (key, value) => {
    expect(() => loadConfig({ ...GCP, [key]: value })).toThrow(/gcp profile refuses/);
  });

  it('gcp refuses the Firebase emulators (both hosts)', () => {
    expect(() => loadConfig({ ...GCP, NODE_ENV: 'development', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085' })).toThrow(
      /emulator/,
    );
    expect(() =>
      loadConfig({ ...GCP, NODE_ENV: 'development', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }),
    ).toThrow(/emulator/);
  });

  it('gcp never falls back to a mock adapter: the real adapters are required (they arrive in L1/L2)', () => {
    const config = loadConfig(GCP);
    expect(() => createProviders(config)).toThrow(AdapterNotAvailableError);
  });

  it('the demo storefront (shopper sign-in, demo orders) and the local upload target are local-only', () => {
    expect(profileFeatures(loadConfig(GCP))).toEqual({ demoStorefront: false, localUploads: false });
    expect(profileFeatures(loadConfig({}))).toEqual({ demoStorefront: true, localUploads: true });
  });

  it('when not wired (gcp), those routes are not mounted at all', async () => {
    const { app } = buildTestWorld({ demoStorefront: false, localUploads: false, profile: 'gcp' });
    // Unknown /api routes ask for sign-in first (existence is never revealed); signed in, they are 404.
    const signedIn = (r: request.Test) => r.set('Origin', TEST_ORIGIN).set('Authorization', bearer('admin_a'));
    expect((await signedIn(request(app).get('/api/demo-storefront/products?brand_id=brand_A'))).status).toBe(404);
    expect((await signedIn(request(app).post('/api/demo-storefront/orders')).send({})).status).toBe(404);
    expect((await signedIn(request(app).post('/api/demo-storefront/shopper-sign-in')).send({})).status).toBe(404);
    expect((await request(app).get('/api/demo-storefront/shoppers').set('Origin', TEST_ORIGIN)).status).toBe(401);
    const upload = await request(app)
      .put('/api/local-files/uploads/upl_x')
      .set('Authorization', bearer('admin_a'))
      .set('Content-Type', 'text/csv')
      .send('a,b');
    expect(upload.status).toBe(404);
    expect((await request(app).get('/api/health')).body.profile).toBe('gcp');
  });
});
