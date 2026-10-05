import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiContext } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import { SHOPPER_SESSION_HEADER, ShopperChat } from '../lib/shopperApi';
import type { IntentTracker } from '../pages/shopper/ShopPage';
import SNIPPET from '../../public/qwikspot-intent.js?raw';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('storefront snippet (public/qwikspot-intent.js)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    delete window.QwikspotIntent;
    // eslint-disable-next-line no-new-func
    new Function(SNIPPET)();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps an opaque session id (sessionStorage) and visitor id (localStorage), and posts events without PII', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(
        {
          accepted: true,
          intent_stage: 'CART',
          intent_strength: 'HIGH_INTENT',
          intent_type: 'CART_ABANDONMENT',
          whatsapp: null,
        },
        202,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tracker = window.QwikspotIntent!.init({
      apiBaseUrl: 'https://api.test/',
      brandId: 'brd_demo',
      openLink: vi.fn(),
    });
    const ids = tracker.ids();
    expect(ids.web_session_id).toMatch(/^ws_[0-9a-f]{32}$/);
    expect(ids.visitor_id).toMatch(/^vis_[0-9a-f]{32}$/);
    expect(sessionStorage.getItem('qs_web_session_id')).toBe(ids.web_session_id);
    expect(localStorage.getItem('qs_visitor_id')).toBe(ids.visitor_id);

    await tracker.track('ADD_TO_CART', { variantId: 'gid://shopify/ProductVariant/2001' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/api/intents');
    expect(init!.credentials).toBe('omit');
    const body = JSON.parse(String(init!.body));
    expect(Object.keys(body).sort()).toEqual(
      ['brand_id', 'client_event_id', 'event_type', 'shopify_variant_id', 'visitor_id', 'web_session_id'].sort(),
    );

    tracker.newSession();
    expect(tracker.ids().web_session_id).not.toBe(ids.web_session_id);
    expect(tracker.ids().visitor_id).toBe(ids.visitor_id);
    tracker.forgetVisitor();
    expect(tracker.ids().visitor_id).not.toBe(ids.visitor_id);
  });

  it('whatsapp() records the click and opens the returned link with the prefilled text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          accepted: true,
          intent_stage: 'PRODUCT_VIEW',
          intent_strength: 'HIGH_INTENT',
          intent_type: 'STORE_ORIENTED',
          whatsapp: {
            prefilled_text: 'START_QWIKSPOT_X',
            wa_link: 'https://wa.me/91?text=START_QWIKSPOT_X',
            expires_at: '',
          },
        }),
      ),
    );
    const openLink = vi.fn();
    const tracker = window.QwikspotIntent!.init({ apiBaseUrl: '', brandId: 'brd_demo', openLink });
    await tracker.whatsapp('STORE_NEED', 'gid://shopify/ProductVariant/2001');
    expect(openLink).toHaveBeenCalledWith('https://wa.me/91?text=START_QWIKSPOT_X', 'START_QWIKSPOT_X');
  });
});

const PRODUCTS = [
  {
    product_id: 'prd_1001',
    title: 'Vitamin C Glow Serum',
    description: 'Serum',
    category: 'Serum',
    image_url: '/demo-products/vitamin-c-glow-serum.png',
    variants: [
      { shopify_variant_id: 'gid://shopify/ProductVariant/2001', title: '30 ml', price: 795, currency: 'INR' },
    ],
  },
];
const SHOPPERS = [{ shopper_id: 'gid://shopify/Customer/3002', first_name: 'Asha', marketing_consent: 'OPTED_IN' }];

type Call = { url: string; init?: RequestInit };

/** A fake backend for the public shopper routes; records every call. */
function fakeBackend(config: unknown = { demo_mode: true, logins: [], shopper_demo: { brand_id: 'brd_demo' } }) {
  const calls: Call[] = [];
  const brandMessages: unknown[] = [];
  let n = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === '/api/demo/config') return json(config);
    if (url.startsWith('/api/demo-storefront/products')) return json({ products: PRODUCTS });
    if (url === '/api/demo-storefront/shoppers') return json({ shoppers: SHOPPERS });
    if (url === '/api/demo-storefront/shopper-sign-in') return json({ ok: true });
    if (url === '/api/shopper/session')
      return json(
        {
          session_token: `tok_${++n}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          brand: { brand_id: 'brd_demo', display_name: 'Demo Beauty Co', logo_url: null },
        },
        201,
      );
    if (url.startsWith('/api/shopper/messages') && init?.method === 'POST') {
      brandMessages.push({
        message_id: 'msg_0002',
        direction: 'OUTBOUND',
        from: 'BRAND',
        message_type: 'TEXT',
        text: 'Which store is near you? Share your location.',
        options: null,
        location: null,
        parts: null,
        delivery_status: 'SENT',
        timestamp: '2026-10-05T10:00:01.000Z',
      });
      return json({ conversation_id: 'conv_1', messages: [] }, 201);
    }
    if (url.startsWith('/api/shopper/messages')) return json({ conversation_id: 'conv_1', messages: brandMessages });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function fakeTracker() {
  let openLink: ((link: string | null, prefilled: string) => void) | null = null;
  const track = vi.fn(async (type: string) => ({
    intent_stage: type === 'ADD_TO_CART' ? 'CART' : 'VISIT',
    intent_strength: 'HIGH_INTENT',
    intent_type: type === 'ADD_TO_CART' ? 'CART_ABANDONMENT' : 'VISIT_ONLY',
    whatsapp: null,
  }));
  const tracker: IntentTracker = {
    init: (o) => {
      openLink = o.openLink;
      return tracker;
    },
    ids: () => ({ web_session_id: 'ws_test_session_1', visitor_id: 'vis_test_visitor_1' }),
    track,
    whatsapp: vi.fn(async () => {
      openLink?.(null, 'START_QWIKSPOT_0123456789ABCDEFGHJKMNPQRS');
      return {
        intent_stage: 'PRODUCT_VIEW',
        intent_strength: 'HIGH_INTENT',
        intent_type: 'STORE_ORIENTED',
        whatsapp: null,
      };
    }),
    newSession: vi.fn(),
    forgetVisitor: vi.fn(),
  };
  return tracker;
}

const auth: AuthState = { user: null, loading: false, signIn: vi.fn(), signOut: vi.fn() };
const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() } as unknown as ApiClient;
const renderAt = (path: string, profile: 'local' | 'gcp' = 'local') =>
  render(
    <AuthContext.Provider value={auth}>
      <ApiContext.Provider value={api}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes profile={profile} />
        </MemoryRouter>
      </ApiContext.Provider>
    </AuthContext.Provider>,
  );

/** No request from the shopper pages may carry a customer ref: the server issues it. */
function expectNoRefSent(calls: Call[]) {
  for (const c of calls) {
    const body = typeof c.init?.body === 'string' ? c.init.body : '';
    expect(body).not.toMatch(/customer_ref|simulator_customer_ref|judge_|shopper_3002/);
    expect(c.url).not.toMatch(/customer|judge_/);
  }
}

describe('/shop — the demo store with the Qwikspot widget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.QwikspotIntent;
    sessionStorage.clear();
    localStorage.clear();
  });

  it('renders the labelled store with product images, records a visit, and replays a journey from Demo controls', async () => {
    const tracker = fakeTracker();
    window.QwikspotIntent = tracker;
    fakeBackend();
    renderAt('/shop');
    expect(await screen.findByText('Demo storefront · synthetic data')).toBeInTheDocument();
    await waitFor(() => expect(tracker.track).toHaveBeenCalledWith('STOREFRONT_VISIT', undefined));
    const card = await screen.findByRole('button', { name: /Vitamin C Glow Serum/ });
    expect(card.querySelector('img')).toHaveAttribute('src', '/demo-products/vitamin-c-glow-serum.png');

    fireEvent.click(screen.getByRole('button', { name: /Demo controls/ }));
    expect(
      await screen.findByRole('button', { name: /Sign in as demo shopper: Asha \(opted in\)/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '4. Product → add to cart → leave' }));
    await waitFor(() => expect(tracker.newSession).toHaveBeenCalled());
    await waitFor(() =>
      expect((tracker.track as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
        'STOREFRONT_VISIT',
        'STOREFRONT_VISIT',
        'PRODUCT_DETAIL_VIEW',
        'VARIANT_SELECTED',
        'ADD_TO_CART',
      ]),
    );
    expect(await screen.findByLabelText('Last intent')).toHaveTextContent('Cart abandonment');
  });

  it('the product page shows the widget; on a phone "Need it today?" opens /chat with the prefilled text', async () => {
    window.QwikspotIntent = fakeTracker();
    const calls = fakeBackend();
    renderAt('/shop');
    fireEvent.click(await screen.findByRole('button', { name: /Vitamin C Glow Serum/ }));
    const widget = screen.getByRole('complementary', { name: 'Get it today' });
    expect(within(widget).getByText('Powered by Qwikspot')).toBeInTheDocument();
    fireEvent.click(within(widget).getByRole('button', { name: /Need it today\? Check a store near you/ }));
    // /chat, full screen, with the text in the fragment.
    expect(await screen.findByRole('region', { name: 'Chat with Demo Beauty Co' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveValue('START_QWIKSPOT_0123456789ABCDEFGHJKMNPQRS');
    expectNoRefSent(calls);
  });

  it('signing in as a demo shopper asks the server for that shopper by id; the browser never sends a ref', async () => {
    window.QwikspotIntent = fakeTracker();
    const calls = fakeBackend();
    renderAt('/shop');
    fireEvent.click(await screen.findByRole('button', { name: /Demo controls/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Sign in as demo shopper: Asha/ }));
    expect(await screen.findByText(/Signed in as Asha/)).toBeInTheDocument();
    const session = calls.find((c) => c.url === '/api/shopper/session')!;
    expect(JSON.parse(String(session.init!.body))).toEqual({
      brand_id: 'brd_demo',
      shopper_id: 'gid://shopify/Customer/3002',
    });
    expectNoRefSent(calls);
  });
});

describe('/chat — the brand chat as the shopper sees it', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('starts a server-issued session, sends with the session header only, and shows the reply', async () => {
    const calls = fakeBackend();
    renderAt('/chat?brand=brd_demo#text=Need%20it%20today');
    expect(await screen.findByText('Demo · synthetic data ·', { exact: false })).toBeInTheDocument();
    const input = await screen.findByLabelText('Message');
    expect(input).toHaveValue('Need it today');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/shopper/session')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Which store is near you? Share your location.')).toBeInTheDocument();

    const session = calls.find((c) => c.url === '/api/shopper/session')!;
    expect(JSON.parse(String(session.init!.body))).toEqual({ brand_id: 'brd_demo' });
    const post = calls.find((c) => c.url === '/api/shopper/messages' && c.init?.method === 'POST')!;
    expect(Object.keys(JSON.parse(String(post.init!.body))).sort()).toEqual(['client_message_id', 'content']);
    expect((post.init!.headers as Record<string, string>)[SHOPPER_SESSION_HEADER]).toBe('tok_1');
    expectNoRefSent(calls);
    expect(sessionStorage.getItem('qs_shopper_session:brd_demo')).toContain('tok_1');
  });

  it('a 401 (expired session) starts a fresh guest session once and retries', async () => {
    const calls: Call[] = [];
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === '/api/shopper/session')
          return json(
            {
              session_token: `tok_${++n}`,
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              brand: { brand_id: 'brd_demo', display_name: 'Demo Beauty Co', logo_url: null },
            },
            201,
          );
        const token = (init?.headers as Record<string, string>)[SHOPPER_SESSION_HEADER];
        if (token === 'tok_1') return json({ error: { code: 'SHOPPER_SESSION_INVALID', message: 'x' } }, 401);
        return json({ conversation_id: null, messages: [] });
      }),
    );
    const chat = new ShopperChat('brd_demo');
    await chat.start();
    await expect(chat.messages()).resolves.toEqual({ conversation_id: null, messages: [] });
    expect(calls.filter((c) => c.url === '/api/shopper/session')).toHaveLength(2);
  });
});

describe('where the shopper demo is not served (gcp, DEMO_MODE off)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['/shop', '/chat', '/demo-store'])(
    '%s shows the notice and calls nothing but the demo config',
    async (path) => {
      const calls = fakeBackend({ demo_mode: false });
      renderAt(path, 'gcp');
      expect(
        await screen.findByRole('heading', { name: "The shopper demo isn't available here." }),
      ).toBeInTheDocument();
      expect([...new Set(calls.map((c) => c.url))]).toEqual(['/api/demo/config']);
    },
  );
});
