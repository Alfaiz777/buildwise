import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiContext } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import '../lib/intentTracker';
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

describe('the shopper demo was removed (the journey runs on the real Shopify store)', () => {
  it.each(['/shop', '/chat', '/demo-store'])('%s lands on the landing page', async (path) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ demo_mode: false })),
    );
    const auth: AuthState = { user: null, loading: false, signIn: vi.fn(), signOut: vi.fn() };
    const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() } as unknown as ApiClient;
    render(
      <AuthContext.Provider value={auth}>
        <ApiContext.Provider value={api}>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
          </MemoryRouter>
        </ApiContext.Provider>
      </AuthContext.Provider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: /Your shopper wants it today/ })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
