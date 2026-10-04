import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState, type AuthUser } from '../auth/authContext';

/** UI-1: role-aware login (Brand / Store / Qwikspot team) and the scope-mismatch toast. */

const LOGINS = [
  { email: 'admin@demo-brand.test', password: 'pw-a', role: 'BRAND_ADMIN', title: 'Brand Admin — Demo', hint: 'h' },
  {
    email: 'andheri@qwikspot.test',
    password: 'pw-b',
    role: 'RETAIL_ADMIN',
    title: 'Retail Admin — Andheri Store',
    hint: 'h',
  },
  { email: 'platform@qwikspot.test', password: 'pw-c', role: 'PLATFORM_ADMIN', title: 'Platform Admin', hint: 'h' },
];

const ME: Record<string, MeResponse> = {
  BRAND: {
    scope: 'BRAND',
    role: 'BRAND_ADMIN',
    user: { user_id: 'a', email: 'a@x.test' },
    brand_id: 'brd_demo',
    brand_name: 'Demo Beauty Co',
  },
  RETAIL: {
    scope: 'RETAIL',
    role: 'RETAIL_ADMIN',
    user: { user_id: 'r', email: 'r@x.test' },
    brand_id: 'brd_demo',
    brand_name: 'Demo Beauty Co',
    retailer_id: 'rtl',
    retailer_name: 'North Retail',
    store_id: 'st',
    store: {
      store_id: 'st',
      store_name: 'Andheri Store',
      city: 'Mumbai',
      address: null,
      store_status: 'ACTIVE',
      store_hours: null,
    },
  },
  PLATFORM: { scope: 'PLATFORM', role: 'PLATFORM_ADMIN', user: { user_id: 'p', email: 'p@x.test' } },
};

function apiAs(me: MeResponse): ApiClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path === '/api/me') return me;
      // Console pages after the redirect: empty, well-formed answers.
      if (path.includes('inventory')) return { items: [] };
      if (path.includes('summary')) return { days: 7, reservations: 0, completed: 0, refused: 0, expired: 0 };
      if (path.includes('reservations')) return { reservations: [] };
      if (path.includes('platform/brands')) return { brands: [] };
      if (path.includes('platform/audit')) return { events: [] };
      if (path.includes('/api/brand/demo')) return { reset_available: false };
      if (path.includes('connections')) return { connections: [] };
      if (path === '/api/products')
        return {
          products: [],
          retail_mappings_needing_attention: [],
          mapping_summary: { auto_matched: 0, needs_attention: 0 },
        };
      if (path.includes('retail-imports')) return { imports: [] };
      if (path.includes('retailers')) return { retailers: [] };
      if (path.includes('stores')) return { stores: [] };
      if (path.includes('users')) return { users: [] };
      throw new Error(`unexpected GET ${path}`);
    }) as ApiClient['get'],
    post: vi.fn() as ApiClient['post'],
    patch: vi.fn() as ApiClient['patch'],
    upload: vi.fn() as ApiClient['upload'],
  };
}

/** A tiny auth provider whose signIn really signs in, so the login flow runs end to end. */
function Harness({ path, api }: { path: string; api: ApiClient }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const auth: AuthState = {
    user,
    loading: false,
    signIn: async (email) => setUser({ uid: 'u', email }),
    signOut: async () => setUser(null),
  };
  return (
    <AuthContext.Provider value={auth}>
      <ApiContext.Provider value={api}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ApiContext.Provider>
    </AuthContext.Provider>
  );
}

function stubConfig(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

async function signIn() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'someone@x.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('role-aware login', () => {
  it.each([
    ['/login?as=brand', 'Brand', 'Brand login', 'Sign in to see what Qwikspot did for your brand.'],
    ['/login?as=store', 'Store', 'Store login', "Sign in to manage your store's holds."],
    ['/login?as=platform', 'Qwikspot team', 'Qwikspot team', 'Sign in to onboard brands and watch the network.'],
    ['/login', 'Brand', 'Brand login', 'Sign in to see what Qwikspot did for your brand.'],
  ])('%s preselects %s with its copy', (path, tab, heading, line) => {
    stubConfig({ demo_mode: false });
    render(<Harness path={path} api={apiAs(ME.BRAND!)} />);
    expect(screen.getByRole('radio', { name: tab })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it('switching tabs (click or arrow keys) changes the copy and filters the demo panel to that role', async () => {
    stubConfig({ demo_mode: true, logins: LOGINS });
    render(<Harness path="/login?as=brand" api={apiAs(ME.BRAND!)} />);
    const panel = await screen.findByRole('region', { name: 'Try the demo' });
    expect(
      within(panel)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Use Brand Admin — Demo']);
    fireEvent.click(screen.getByRole('radio', { name: 'Store' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Store login' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Try the demo' })).getByText('Retail Admin — Andheri Store'));
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Store' }), { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Qwikspot team' })).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Qwikspot team' }));
    const team = screen.getByRole('region', { name: 'Try the demo' });
    expect(within(team).getByText('Platform Admin', { selector: 'strong' })).toBeInTheDocument();
    expect(within(team).queryByText('Brand Admin — Demo')).not.toBeInTheDocument();
    fireEvent.click(within(team).getByRole('button', { name: 'Use Platform Admin' }));
    expect(screen.getByLabelText('Email')).toHaveValue('platform@qwikspot.test');
  });

  it.each([
    ['/login?as=brand', 'RETAIL', 'This is a Store account. Taking you to the Store Console.', 'Store Console'],
    ['/login?as=store', 'BRAND', 'This is a Brand account. Taking you to the Brand Console.', 'Brand Console'],
    [
      '/login?as=brand',
      'PLATFORM',
      'This is a Qwikspot team account. Taking you to the Platform Console.',
      'Platform Console',
    ],
  ])(
    'signing in from %s with a %s account still goes to the right console, with a toast',
    async (path, scope, toast, consoleName) => {
      stubConfig({ demo_mode: false });
      render(<Harness path={path} api={apiAs(ME[scope]!)} />);
      await signIn();
      expect(await screen.findByText(consoleName)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText('Notifications')).toHaveTextContent(toast));
    },
  );

  it('no toast when the tab matches the account', async () => {
    stubConfig({ demo_mode: false });
    render(<Harness path="/login?as=store" api={apiAs(ME.RETAIL!)} />);
    await signIn();
    expect(await screen.findByText('Store Console')).toBeInTheDocument();
    expect(screen.getByLabelText('Notifications')).toHaveTextContent('');
  });
});
