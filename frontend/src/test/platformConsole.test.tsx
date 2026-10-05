import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import { nextStep, type Brand, type BrandNetwork, type NetworkResponse } from '../pages/platform/platformTypes';

/** UI-5: the Platform Console — aggregates only (Change 16; audit Platform findings). */

const PLATFORM: MeResponse = { scope: 'PLATFORM', role: 'PLATFORM_ADMIN', user: { user_id: 'p', email: 'p@q.test' } };

const ONBOARDING = {
  brand_admin_provisioned: true,
  catalog: { synced: true, failed: false, last_sync_at: '2026-10-05T06:00:00.000Z', product_count: 10 },
  stores: { total: 4, with_stock: 4 },
  sku_mapping: { auto_matched: 36, needs_attention: 0 },
  retail_admins: { provisioned: 4, stores_with_retailer: 4 },
  channel: { simulator: true, whatsapp_number_configured: false },
};
const BRANDS: Brand[] = [
  {
    brand_id: 'brd_demo',
    name: 'Demo Beauty Co',
    status: 'ACTIVE',
    created_at: null,
    brand_admin_user_id: 'u1',
    onboarding: ONBOARDING,
  },
  {
    brand_id: 'brd_new',
    name: 'New Brand',
    status: 'ACTIVE',
    created_at: null,
    brand_admin_user_id: 'u2',
    onboarding: {
      ...ONBOARDING,
      stores: { total: 0, with_stock: 0 },
      retail_admins: { provisioned: 0, stores_with_retailer: 0 },
    },
  },
];
const money = (amount: number) => ({ amount, currency: 'INR' });
const AGG = {
  stores_total: 4,
  stores_live: 2,
  holds: 12,
  pickups: 7,
  offline_value: money(5565),
  online_orders: 8,
  online_value: money(6360),
  completion_pct: 64,
  fill_pct: 71,
  unmet_demand: 13,
  follow_ups_sent: 12,
};
const NETWORK: NetworkResponse = {
  period: { days: 7, from: '', to: '' },
  demo_history: { included: true, records: 209 },
  totals: { ...AGG, brands_active: 2, retailers: 2 },
  brands: [
    {
      ...AGG,
      brand_id: 'brd_demo',
      name: 'Demo Beauty Co',
      status: 'ACTIVE',
      stores_flagged: 2,
      last_activity_at: null,
    },
    { ...AGG, brand_id: 'brd_new', name: 'New Brand', status: 'ACTIVE', stores_flagged: 0, last_activity_at: null },
  ],
};
const store = (over: Partial<BrandNetwork['retailers'][number]['stores'][number]>) => ({
  store_id: 'st_north_2',
  store_name: 'Andheri Store',
  city: 'Mumbai',
  status: 'ACTIVE',
  store_admin_provisioned: true,
  stock: { sku_count: 9, freshness: 'FRESH' as const, updated_at: '2026-10-05T06:00:00.000Z' },
  holds: 10,
  completed: 6,
  refused: { NOT_ACTUALLY_IN_STOCK: 0, DAMAGED: 1, STORE_CLOSING_EARLY: 0, OTHER: 0 },
  expired: 2,
  completion_pct: 67,
  nearest_lookups: 40,
  fill_pct: 40,
  active_holds: 1,
  stale_holds: 0,
  flags: ['LOW_FILL_RATE' as const],
  ...over,
});
const BRAND_NETWORK: BrandNetwork = {
  brand_id: 'brd_demo',
  name: 'Demo Beauty Co',
  status: 'ACTIVE',
  period: { days: 7, from: '', to: '' },
  demo_history: { included: true },
  retailers: [
    {
      retailer_id: 'rtl_north',
      name: 'North Retail',
      status: 'ACTIVE',
      stores: [
        store({}),
        store({
          store_id: 'st_north_3',
          store_name: 'Powai Store',
          store_admin_provisioned: false,
          stock: { sku_count: 0, freshness: 'NONE', updated_at: null },
          flags: ['NO_STOCK_UPLOAD', 'NO_STORE_ADMIN'],
        }),
        store({ store_id: 'st_north_1', store_name: 'Bandra Store', flags: [], fill_pct: 95 }),
      ],
    },
  ],
  unassigned_stores: [],
};
const AUDIT = {
  events: [
    {
      audit_id: 'a1',
      actor_role: 'PLATFORM_ADMIN',
      action: 'BRAND_SUSPENDED',
      target_brand_id: 'brd_new',
      target_brand_name: 'New Brand',
      target_id: 'brd_new',
      result: 'SUCCESS',
      reason_code: 'Payment overdue',
      timestamp: '2026-10-05T09:00:00.000Z',
    },
    {
      audit_id: 'a2',
      actor_role: 'SYSTEM',
      action: 'BRAND_CREATED',
      target_brand_id: 'brd_demo',
      target_brand_name: 'Demo Beauty Co',
      target_id: 'brd_demo',
      result: 'DENIED',
      reason_code: null,
      timestamp: '2026-10-04T09:00:00.000Z',
    },
  ],
};

function platformApi(): ApiClient {
  return {
    get: vi.fn(async (p: string) => {
      if (p === '/api/me') return PLATFORM;
      if (p.startsWith('/api/platform/network')) return NETWORK;
      if (p.startsWith('/api/platform/brands/brd_demo/network')) return BRAND_NETWORK;
      if (p === '/api/platform/brands') return { brands: BRANDS };
      if (p.startsWith('/api/platform/audit')) return AUDIT;
      throw new Error(`unexpected GET ${p}`);
    }) as ApiClient['get'],
    post: vi.fn() as ApiClient['post'],
    patch: vi.fn() as ApiClient['patch'],
    upload: vi.fn() as ApiClient['upload'],
  };
}

function renderAt(path: string, api = platformApi()) {
  const auth: AuthState = { user: { uid: 'u', email: 'u@test' }, loading: false, signIn: vi.fn(), signOut: vi.fn() };
  render(
    <AuthContext.Provider value={auth}>
      <ApiContext.Provider value={api}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ApiContext.Provider>
    </AuthContext.Provider>,
  );
  return api;
}

afterEach(() => vi.unstubAllGlobals());

describe('Overview', () => {
  it('aggregate tiles across brands, the synthetic marker, and the brands needing attention', async () => {
    const api = renderAt('/platform');
    const tiles = await screen.findByRole('region', { name: 'Across all brands' });
    expect(within(tiles).getByText('Stores live').parentElement).toHaveTextContent('2of 4 stores');
    expect(within(tiles).getByText('₹5,565')).toBeInTheDocument();
    expect(within(tiles).getByText('64%')).toBeInTheDocument();
    expect(within(tiles).getByText('71%')).toBeInTheDocument();
    expect(within(tiles).getAllByText('Includes synthetic history').length).toBeGreaterThan(0);
    expect(screen.getByText(/Includes synthetic demo history \(209 generated records\)/)).toBeInTheDocument();
    expect(await screen.findByText(/Waiting for the brand to import store stock\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2 stores flagged →' })).toHaveAttribute(
      'href',
      '/platform/network?brand=brd_demo',
    );
    expect(api.get).toHaveBeenCalledWith('/api/platform/network?days=7&include_history=true');
    fireEvent.click(screen.getByLabelText('Include synthetic history'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/platform/network?days=7&include_history=false'));
  });
});

describe('Retail network', () => {
  it('retailers → stores with counts and health flags in words; never an email', async () => {
    renderAt('/platform/network?brand=brd_demo');
    expect(await screen.findByText('2 of 3 stores need attention.')).toBeInTheDocument();
    const powai = screen.getByText('Powai Store').closest('tr')!;
    expect(within(powai).getByText('No stock upload')).toBeInTheDocument();
    expect(within(powai).getByText('No Store Admin')).toBeInTheDocument();
    expect(within(powai).getByText('Not yet')).toBeInTheDocument();
    const andheri = screen.getByText('Andheri Store').closest('tr')!;
    expect(within(andheri).getByText('Low fill rate')).toBeInTheDocument();
    expect(within(andheri).getByText('damaged 1')).toBeInTheDocument();
    expect(within(screen.getByText('Bandra Store').closest('tr')!).getByText('Healthy')).toBeInTheDocument();
    // The header shows the signed-in Platform Admin's own email; the page content never shows one.
    expect(screen.getByRole('main').textContent).not.toMatch(/@/);
  });
});

describe('Audit', () => {
  it('shows brand names, the actor role, the reason and the result, with filters', async () => {
    renderAt('/platform/audit');
    const table = await screen.findByRole('table', { name: 'Platform audit' });
    const row = within(table).getByText('Brand suspended').closest('tr')!;
    expect(row).toHaveTextContent('New Brand');
    expect(row).toHaveTextContent('Platform Admin');
    expect(row).toHaveTextContent('Payment overdue');
    expect(within(row).getByText('Success')).toBeInTheDocument();
    expect(within(table).getByText('Brand created').closest('tr')).toHaveTextContent('System');
    fireEvent.change(screen.getByLabelText('Filter by result'), { target: { value: 'DENIED' } });
    expect(screen.queryByText('Brand suspended')).not.toBeInTheDocument();
    expect(screen.getByText('Brand created')).toBeInTheDocument();
  });
});

describe('System', () => {
  it('reads /api/health and explains each part in plain words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'ok',
              version: '1.4.0',
              commit: 'abc1234',
              profile: 'local',
              adapters: { agent_runtime: 'MOCK', channels: ['SIMULATOR'], commerce: 'MOCK' },
            }),
            { status: 200 },
          ),
      ),
    );
    renderAt('/platform/system');
    expect(
      await screen.findByText(/deterministic rules use the same tools and safety checks Gemini will use/),
    ).toBeInTheDocument();
    expect(screen.getByText(/the shopper demo's chat; WhatsApp when it is connected/)).toBeInTheDocument();
    expect(screen.getByText(/a synthetic Shopify-shaped catalogue/)).toBeInTheDocument();
    expect(screen.getByText('1.4.0 · abc1234')).toBeInTheDocument();
  });

  it('an unreachable health check offers Try again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    renderAt('/platform/system');
    expect(await screen.findByText('The backend health check did not answer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('Brands and navigation', () => {
  it('next step in words, from the first unfinished onboarding item', () => {
    expect(nextStep(BRANDS[0]!)).toBe('Live.');
    expect(nextStep(BRANDS[1]!)).toBe('Waiting for the brand to import store stock.');
    expect(
      nextStep({
        ...BRANDS[0]!,
        brand_admin_user_id: null,
        onboarding: { ...ONBOARDING, brand_admin_provisioned: false },
      }),
    ).toBe('Provision its Brand Admin.');
    expect(nextStep({ ...BRANDS[0]!, status: 'SUSPENDED' })).toBe('Suspended — reactivate to continue.');
  });

  it('Brands shows the next step and the last 7 days; nav is Overview · Brands · Retail network · Audit · System', async () => {
    renderAt('/platform/brands');
    const row = (await screen.findByText('New Brand')).closest('tr')!;
    expect(within(row).getByText('Waiting for the brand to import store stock.')).toBeInTheDocument();
    const demo = screen.getByText('Demo Beauty Co').closest('tr')!;
    expect(await within(demo).findByText('12 holds · 7 pickups · 8 online orders')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Platform Console' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Overview', 'Brands', 'Retail network', 'Audit', 'System']);
  });
});
