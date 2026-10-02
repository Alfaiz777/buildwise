/**
 * npm run demo:check — a smoke walk through the running product, over HTTP only.
 *
 * It signs in as the four demo users (Firebase Auth REST), then walks:
 *   health → platform brands → brand console (me, products) → retailer stock →
 *   simulator conversation → AI decision → reservation → store transitions with the
 *   pickup code → OFFLINE outcome in insights.
 * It prints one ✔ / ✘ line per step and exits 1 on the first failure. It never calls
 * Reset demo and uses a fresh `judge_check_xxxx` customer, so it is safe on a shared demo.
 *
 * Environment (no secrets in the repo — pass them in):
 *   BASE_URL                 API origin (default http://localhost:8080)
 *   STOREFRONT_ORIGIN        an allowlisted storefront origin (default http://localhost:5173)
 *   DEMO_BRAND_ID            default brd_demo
 *   DEMO_PASSWORD            the demo users' password (local default: the seed password)
 *   DEMO_BRAND_ADMIN_EMAIL, DEMO_RETAIL_ADMIN_EMAILS (comma-separated), DEMO_PLATFORM_ADMIN_EMAIL
 *   FIREBASE_API_KEY         live only: the web API key; without it the Auth emulator is used
 *   FIREBASE_AUTH_EMULATOR_HOST  default 127.0.0.1:9099
 */
import { LOCAL_DEMO_PASSWORD } from '../src/config/env.js';

const env = process.env;
const BASE_URL = (env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const ORIGIN = env.STOREFRONT_ORIGIN ?? 'http://localhost:5173';
const BRAND = env.DEMO_BRAND_ID ?? 'brd_demo';
const PASSWORD = env.DEMO_PASSWORD ?? LOCAL_DEMO_PASSWORD;
const BRAND_ADMIN = env.DEMO_BRAND_ADMIN_EMAIL ?? 'admin@demo-brand.test';
const RETAIL_ADMINS = (
  env.DEMO_RETAIL_ADMIN_EMAILS ?? 'retail-admin-north-1@qwikspot.test,retail-admin-north-2@qwikspot.test'
).split(',');
const PLATFORM_ADMIN = env.DEMO_PLATFORM_ADMIN_EMAIL ?? 'platform@qwikspot.test';
const AUTH_URL = env.FIREBASE_API_KEY
  ? `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_API_KEY}`
  : `http://${env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
const NEAR_POWAI = { latitude: 19.12, longitude: 72.9 };

class CheckFailed extends Error {}
const ok = (label: string) => console.log(`✔ ${label}`);
function must(condition: unknown, why: string): asserts condition {
  if (!condition) throw new CheckFailed(why);
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    const value = await run();
    ok(label);
    return value;
  } catch (err) {
    const reason = err instanceof CheckFailed ? err.message : (err as Error).message;
    console.log(`✘ ${label} — ${reason}`);
    process.exit(1);
  }
}

type Json = Record<string, any>;
async function api(method: string, path: string, token?: string, body?: object, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new CheckFailed(`${method} ${path} → ${res.status} ${json.error?.code ?? ''}`.trim());
  return json;
}

async function signIn(email: string): Promise<string> {
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const body = (await res.json()) as { idToken?: string };
  must(body.idToken, `sign-in failed for ${email.replace(/^(.).*@/, '$1…@')}`);
  return body.idToken;
}

console.log(`Qwikspot demo check → ${BASE_URL} (brand ${BRAND})`);
const ref = `judge_check_${Math.random().toString(36).slice(2, 6)}`;

await step('API is healthy', async () => {
  const h = await api('GET', '/api/health');
  must(h.status === 'ok', 'health is not ok');
  console.log(`    version ${h.version}, profile ${h.profile}`);
});

const tokens = await step('the four demo users sign in', async () => ({
  brand: await signIn(BRAND_ADMIN),
  platform: await signIn(PLATFORM_ADMIN),
  retail: await Promise.all(RETAIL_ADMINS.map((e) => signIn(e.trim()))),
}));

await step('Platform Admin sees the brand list', async () => {
  const res = await api('GET', '/api/platform/brands', tokens.platform);
  must(
    (res.brands as Json[]).some((b) => b.brand_id === BRAND),
    `${BRAND} is not listed`,
  );
});

await step('Brand console: signed in as the Brand Admin, catalogue synced', async () => {
  const me = await api('GET', '/api/me', tokens.brand);
  must(me.role === 'BRAND_ADMIN' && me.brand_id === BRAND, 'not the demo brand admin');
  const products = await api('GET', '/api/products', tokens.brand);
  must((products.products as Json[]).length > 0, 'no products — run the catalogue sync or Reset demo');
});

const retailers = await step('Retailer consoles show their store stock', async () => {
  const out: { token: string; storeId: string }[] = [];
  for (const token of tokens.retail) {
    const me = await api('GET', '/api/me', token);
    const stock = await api('GET', `/api/retail/stores/${me.store_id}/inventory`, token);
    must((stock.items as Json[]).length > 0, `${me.store_id} has no stock rows`);
    out.push({ token, storeId: me.store_id });
  }
  return out;
});

const send = (content: object) =>
  api('POST', '/api/channels/simulator/messages', tokens.brand, {
    simulator_customer_ref: ref,
    client_message_id: `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content,
  });

const offer = await step('Customer: storefront "Need it today?" → simulator chat → store options', async () => {
  const click = await api(
    'POST',
    '/api/intents',
    undefined,
    {
      brand_id: BRAND,
      web_session_id: `ws_${ref}_000000000`,
      visitor_id: `vis_${ref}_0000000`,
      client_event_id: `ce_${ref}`,
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: 'gid://shopify/ProductVariant/2001',
    },
    { Origin: ORIGIN },
  );
  await send({ type: 'TEXT', text: `${click.whatsapp.prefilled_text} I need it today` });
  const res = await send({ type: 'LOCATION', ...NEAR_POWAI });
  const holds = ((res.outbound_messages[0]?.options ?? []) as Json[])
    .map((o) => o.option_id as string)
    .filter((id) => id.startsWith('hold:'));
  must(
    holds.length > 0,
    `no store offered (the assistant said: "${String(res.outbound_messages[0]?.text ?? '').slice(0, 160)}"). ` +
      'Stores must be open and in stock near Powai — Reset demo restores the stock.',
  );
  return holds;
});

const hold = await step('AI decision → guardrail ALLOWED → reservation created', async () => {
  const option = offer.find((o) => retailers.some((r) => `hold:${r.storeId}` === o)) ?? offer[0]!;
  const res = await send({ type: 'INTERACTIVE_REPLY', option_id: option });
  must(res.decision?.guardrail_status === 'ALLOWED', `guardrail ${res.decision?.guardrail_status}`);
  must(res.decision.executed_action?.type === 'RESERVATION_CREATED', 'no reservation');
  const storeId = option.slice(5);
  const retail = retailers.find((r) => r.storeId === storeId);
  must(retail, `the hold went to ${storeId}, which has no demo Retail Admin`);
  return {
    id: res.decision.executed_action.reservation_id as string,
    conversation: res.conversation_id as string,
    retail,
  };
});

await step('Store: confirm → ready → arrived → complete with the pickup code', async () => {
  const move = (status: string, from: string, extra: object = {}) =>
    api('PATCH', `/api/reservations/${hold.id}`, hold.retail.token, {
      status,
      expected_current_status: from,
      ...extra,
    });
  await move('CONFIRMED', 'PENDING');
  const detail = await api('GET', `/api/brand/conversations/${hold.conversation}`, tokens.brand);
  const code = (detail.messages as Json[]).map((m) => /Pickup code (\d{6})/.exec(m.text ?? '')?.[1]).find(Boolean);
  must(code, 'the confirmation message carried no pickup code');
  await move('READY', 'CONFIRMED');
  await move('CUSTOMER_ARRIVED', 'READY');
  const done = await move('COMPLETED', 'CUSTOMER_ARRIVED', { pickup_code: code });
  must(done.status === 'COMPLETED', `status ${done.status}`);
});

await step('Outcome: OFFLINE purchase recorded and visible in insights', async () => {
  const insights = await api('GET', '/api/brand/insights?days=7&include_history=false', tokens.brand);
  must((insights.funnel?.outcomes?.OFFLINE ?? 0) >= 1, 'no OFFLINE outcome in the last 7 days');
});

console.log('All demo checks passed.');
process.exit(0);
