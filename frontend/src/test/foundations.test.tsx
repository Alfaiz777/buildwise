import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeGate } from '../account/meContext';
import { ApiContext, type MeResponse } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import { ConsoleShell } from '../components/ConsoleShell';
import { RedirectKeepingUrl } from '../components/RedirectKeepingUrl';
import type { FrontendProfile } from '../config';

/** UI-0 foundations: public landing, route map, console shell and role banner. */

const BRAND: MeResponse = {
  scope: 'BRAND',
  role: 'BRAND_ADMIN',
  user: { user_id: 'a', email: 'admin@demo-brand.test' },
  brand_id: 'brd_demo',
  brand_name: 'Demo Beauty Co',
};
const STORE: MeResponse = {
  scope: 'RETAIL',
  role: 'RETAIL_ADMIN',
  user: { user_id: 'r', email: 'andheri@demo.test' },
  brand_id: 'brd_demo',
  brand_name: 'Demo Beauty Co',
  retailer_id: 'rtl_north',
  retailer_name: 'North Retail',
  store_id: 'st_north_2',
  store: {
    store_id: 'st_north_2',
    store_name: 'Andheri Store',
    city: 'Mumbai',
    address: null,
    store_status: 'ACTIVE',
    store_hours: null,
  },
};
const PLATFORM: MeResponse = { scope: 'PLATFORM', role: 'PLATFORM_ADMIN', user: { user_id: 'p', email: 'p@q.test' } };

const apiFor = (me: MeResponse): ApiClient => ({
  get: vi.fn(async (path: string) => {
    if (path === '/api/me') return me;
    throw new Error(`unexpected GET ${path}`);
  }) as ApiClient['get'],
  post: vi.fn() as ApiClient['post'],
  patch: vi.fn() as ApiClient['patch'],
  upload: vi.fn() as ApiClient['upload'],
});
const noApi = {
  get: vi.fn(async () => {
    throw new Error('the landing page must not call the API');
  }),
} as unknown as ApiClient;

function auth(user: AuthState['user'] = null): AuthState {
  return { user, loading: false, signIn: vi.fn(), signOut: vi.fn() };
}

function app(path: string, opts: { user?: AuthState['user']; api?: ApiClient; profile?: FrontendProfile } = {}) {
  return render(
    <AuthContext.Provider value={auth(opts.user ?? null)}>
      <ApiContext.Provider value={opts.api ?? noApi}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes profile={opts.profile ?? 'local'} />
        </MemoryRouter>
      </ApiContext.Provider>
    </AuthContext.Provider>,
  );
}

function shell(me: MeResponse, path = '/x') {
  const value = auth({ uid: 'u', email: 'u@test' });
  render(
    <AuthContext.Provider value={value}>
      <ApiContext.Provider value={apiFor(me)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<MeGate />}>
              <Route path="*" element={<ConsoleShell>page content</ConsoleShell>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ApiContext.Provider>
    </AuthContext.Provider>,
  );
  return value;
}

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

// The public landing page is covered by landing.test.tsx (UI-1).

describe('route map', () => {
  it('/app sends each user to their own console; a Retail Admin lands on /store', async () => {
    app('/app', { user: { uid: 'u', email: 'u@test' }, api: apiFor(STORE) });
    expect(await screen.findByText('Store Console')).toBeInTheDocument();
  });

  it('/retailer redirects to /store', async () => {
    app('/retailer', { user: { uid: 'u', email: 'u@test' }, api: apiFor(STORE) });
    expect(await screen.findByText('Store Console')).toBeInTheDocument();
  });

  it('old /demo-store links redirect to /shop keeping ?qs_ref and #product', () => {
    function Probe() {
      const l = useLocation();
      return <output>{`${l.pathname}${l.search}${l.hash}`}</output>;
    }
    render(
      <MemoryRouter initialEntries={['/demo-store?qs_ref=ABC123#product=prd_1001']}>
        <Routes>
          <Route path="/demo-store" element={<RedirectKeepingUrl to="/shop" />} />
          <Route path="/shop" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('/shop?qs_ref=ABC123#product=prd_1001');
  });

  it('/shop serves the demo storefront in the local profile', async () => {
    window.QwikspotIntent = {
      init: () => window.QwikspotIntent!,
      ids: () => ({ web_session_id: 'ws_1', visitor_id: 'vis_1' }),
      track: vi.fn(async () => ({
        intent_stage: 'VISIT',
        intent_strength: 'LOW',
        intent_type: 'VISIT_ONLY',
        whatsapp: null,
      })),
      whatsapp: vi.fn(),
      newSession: vi.fn(),
      forgetVisitor: vi.fn(),
    };
    const body = { demo_mode: true, shopper_demo: { brand_id: 'brd_demo' }, products: [], shoppers: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
    app('/shop');
    expect(await screen.findByText(/Demo storefront/)).toBeInTheDocument();
    delete window.QwikspotIntent;
  });

  it('/ui-kit does not exist in the gcp profile', () => {
    app('/ui-kit', { profile: 'gcp' });
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('/ui-kit shows the component kit in the local profile', () => {
    app('/ui-kit');
    expect(screen.getByRole('heading', { name: 'Buttons' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Example reservations' })).toBeInTheDocument();
  });
});

describe('console shell', () => {
  it('Brand: header, sidebar navigation with the active page, role badge in words, sign out', async () => {
    const value = shell(BRAND, '/brand/conversations');
    expect(await screen.findByText('Brand Console')).toBeInTheDocument();
    expect(screen.getByText('Demo Beauty Co')).toBeInTheDocument();
    expect(screen.getByText('Brand Admin', { selector: '.shell-role' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Brand Console' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Overview', 'Conversations', 'Reservations', 'Insights', 'Network', 'Settings']);
    expect(within(nav).getByRole('link', { name: 'Conversations' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(value.signOut).toHaveBeenCalled();
  });

  it('Store and Platform shells name their console and context', async () => {
    shell(STORE);
    expect(await screen.findByText('Store Console')).toBeInTheDocument();
    expect(screen.getByText('Andheri Store · for Demo Beauty Co via North Retail')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Store Console' })).toBeInTheDocument();
  });

  it('Platform shell says customer data is never shown', async () => {
    shell(PLATFORM);
    expect(await screen.findByText('Platform Console')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Customer data is never shown here.');
  });

  it('the role banner shows on the first visit, and stays dismissed for that console', async () => {
    shell(STORE);
    expect(await screen.findByRole('note')).toHaveTextContent(
      'You run Andheri Store for Demo Beauty Co via North Retail. Holds from customers arrive here.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this note' }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('qs_role_banner_dismissed:RETAIL')).toBe('1');
  });

  it('a dismissed banner does not come back', async () => {
    window.localStorage.setItem('qs_role_banner_dismissed:BRAND', '1');
    shell(BRAND);
    expect(await screen.findByText('Brand Console')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
