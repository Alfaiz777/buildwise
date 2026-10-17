import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  store_name: 'HealthPlus Chemist',
  city: 'Ahmedabad',
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
      name: 'Ahmedabad Retail Partners',
      status: 'ACTIVE',
      stores: [
        store({}),
        store({
          store_id: 'st_north_3',
          store_name: 'Skin Studio',
          store_admin_provisioned: false,
          stock: { sku_count: 0, freshness: 'NONE', updated_at: null },
          nearest_lookups: 0,
          fill_pct: null,
          flags: ['NO_STOCK_UPLOAD', 'NO_STORE_ADMIN'],
        }),
        store({ store_id: 'st_north_1', store_name: 'Wellness Mart', flags: [], fill_pct: 95 }),
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

function platformApi(extra: Record<string, unknown> = {}, post: ApiClient['post'] = vi.fn()): ApiClient {
  return {
    get: vi.fn(async (p: string) => {
      if (p in extra) return extra[p];
      if (p === '/api/me') return PLATFORM;
      if (p.startsWith('/api/platform/network')) return NETWORK;
      if (p.startsWith('/api/platform/brands/brd_demo/network')) return BRAND_NETWORK;
      if (p === '/api/platform/brands') return { brands: BRANDS };
      if (p.startsWith('/api/platform/audit')) return AUDIT;
      throw new Error(`unexpected GET ${p}`);
    }) as ApiClient['get'],
    post: post as ApiClient['post'],
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
  it('aggregate tiles across brands, one demo-history badge, and the brands needing attention', async () => {
    const api = renderAt('/platform');
    const tiles = await screen.findByRole('region', { name: 'Across all brands' });
    expect(within(tiles).getByText('Stores live').parentElement).toHaveTextContent('2 of 4');
    expect(within(tiles).getByText('Active brands').parentElement).toHaveTextContent('2 retailers');
    expect(within(tiles).getByText('Holds → Store pickups').parentElement).toHaveTextContent('12 → 7');
    expect(within(tiles).getByText('₹5,565')).toBeInTheDocument();
    expect(within(tiles).getByText('64%')).toBeInTheDocument();
    expect(within(tiles).getByText('71%')).toBeInTheDocument();
    // One page-level badge, not one per tile; its tooltip has the record count.
    expect(screen.getAllByText('Includes demo history')).toHaveLength(1);
    expect(within(tiles).queryByText(/synthetic/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Includes synthetic demo history \(209 generated records\)/)).toBeInTheDocument();
    expect(await screen.findByText(/Waiting for the brand to import store stock\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review stores' })).toHaveAttribute(
      'href',
      '/platform/network?brand=brd_demo',
    );
    expect(screen.getByRole('link', { name: 'Open brand' })).toHaveAttribute('href', '/platform/brands#brand-brd_new');
    expect(api.get).toHaveBeenCalledWith('/api/platform/network?days=7&include_history=true');
  });

  it('"Live only | Live + demo history" replaces the checkbox and sends the same query; "7 days | 28 days" too', async () => {
    const api = renderAt('/platform');
    await screen.findByRole('region', { name: 'Across all brands' });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const history = screen.getByRole('group', { name: 'History' });
    expect(within(history).getByRole('button', { name: 'Live + demo history' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(history).getByRole('button', { name: 'Live only' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/platform/network?days=7&include_history=false'));
    expect(within(history).getByRole('button', { name: 'Live only' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name: '28 days' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/platform/network?days=28&include_history=false'));
  });

  it('"Needs attention" sits above the tiles; with nothing to do it says so with a green check', async () => {
    renderAt('/platform');
    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    const tiles = await screen.findByRole('region', { name: 'Across all brands' });
    expect(attention.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(attention).getByText('New Brand')).toBeInTheDocument();
    cleanup();
    const healthy = { ...NETWORK, brands: NETWORK.brands.map((b) => ({ ...b, stores_flagged: 0 })) };
    renderAt(
      '/platform',
      platformApi({
        '/api/platform/brands': { brands: [BRANDS[0]] },
        '/api/platform/network?days=7&include_history=true': healthy,
      }),
    );
    expect(await screen.findByText('Every brand is live and no store is flagged.')).toBeInTheDocument();
  });
});

describe('Retail network', () => {
  it('retailers → stores with counts and health flags in words; never an email', async () => {
    renderAt('/platform/network?brand=brd_demo');
    expect(await screen.findByText('2 of 3 stores need attention.')).toBeInTheDocument();
    const skinStudio = screen.getByText('Skin Studio').closest('tr')!;
    expect(within(skinStudio).getByText('No stock upload')).toBeInTheDocument();
    expect(within(skinStudio).getByText('No Store Admin')).toBeInTheDocument();
    expect(within(skinStudio).getByText('Not yet')).toBeInTheDocument();
    // No lookups as nearest: one "—", not "— of 0 as nearest".
    expect(skinStudio).not.toHaveTextContent('as nearest');
    const healthPlus = screen.getByText('HealthPlus Chemist').closest('tr')!;
    expect(within(healthPlus).getByText('Low fill rate')).toBeInTheDocument();
    expect(within(healthPlus).getByText('1 · damaged')).toBeInTheDocument();
    expect(healthPlus).toHaveTextContent('of 40 as nearest');
    expect(within(screen.getByText('Wellness Mart').closest('tr')!).getByText('Healthy')).toBeInTheDocument();
    // Stores that need attention first.
    const rows = within(screen.getByRole('region', { name: 'Ahmedabad Retail Partners' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.at(-1)).toHaveTextContent('Wellness Mart');
    // The header shows the signed-in Platform Admin's own email; the page content never shows one.
    expect(screen.getByRole('main').textContent).not.toMatch(/@/);
  });
});

describe('Audit', () => {
  it('a timeline: the action and brand, by which role and when, the reason only when there is one, the result', async () => {
    renderAt('/platform/audit');
    const timeline = await screen.findByRole('list', { name: 'Platform audit' });
    expect(document.title).toBe('Audit · Platform Console · Qwikspot'); // UI-6 tab titles
    const item = within(timeline).getByText('Brand suspended').closest('li')!;
    expect(item).toHaveTextContent('Brand suspended · New Brand');
    expect(item).toHaveTextContent('by Platform Admin');
    expect(item).toHaveTextContent('Payment overdue');
    expect(within(item).getByText('Success')).toBeInTheDocument();
    expect(within(item).getByRole('tooltip')).toHaveTextContent('2026'); // the full date on hover
    const created = within(timeline).getByText('Brand created').closest('li')!;
    expect(created).toHaveTextContent('by System');
    expect(created).not.toHaveTextContent('—'); // no reason: nothing shown
    expect(screen.getByText(/Every platform action is recorded here/)).toBeInTheDocument();
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
    // UI-P1: status tiles, each with its dot, and what the console can never see.
    const tiles = screen.getByRole('region', { name: 'How Qwikspot runs' });
    expect(
      within(tiles)
        .getAllByText(/^(Status|Hosting|AI|Customer channel|Commerce|Version)$/)
        .map((e) => e.textContent),
    ).toEqual(['Status', 'Hosting', 'AI', 'Customer channel', 'Commerce', 'Version']);
    expect(within(tiles).getByText('Running')).toBeInTheDocument();
    const never = screen.getByRole('region', { name: 'What this console can never see' });
    expect(never).toHaveTextContent('Phone numbers');
    expect(never).toHaveTextContent('enforced by the backend, not just hidden in the UI');
  });

  it('with the Gemini runtime the System page says "Gemini (Vertex AI)" (L3-Gemini)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'ok',
              version: '1.5.0',
              commit: 'abc1234',
              profile: 'gcp',
              adapters: { agent_runtime: 'GEMINI', channels: ['SIMULATOR', 'WHATSAPP'], commerce: 'SHOPIFY' },
            }),
            { status: 200 },
          ),
      ),
    );
    renderAt('/platform/system');
    expect(await screen.findByText('Gemini (Vertex AI)')).toBeInTheDocument();
    expect(screen.queryByText('Mock AI')).not.toBeInTheDocument();
    expect(screen.getByText('Gemini on Vertex AI decides; safety checks run on every reply.')).toBeInTheDocument();
    expect(screen.getByText('Google Cloud · Cloud Run + Firestore')).toBeInTheDocument();
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
    const card = await screen.findByRole('article', { name: 'New Brand' });
    expect(within(card).getByText(/Waiting for New Brand to import store stock\./)).toBeInTheDocument();
    const demo = screen.getByRole('article', { name: 'Demo Beauty Co' });
    await waitFor(() => expect(demo).toHaveTextContent('12 holds7 pickups8 online orders'));
    expect(within(demo).getByRole('link', { name: '2 stores flagged →' })).toHaveAttribute(
      'href',
      '/platform/network?brand=brd_demo',
    );
    expect(within(demo).getByText('Live — nothing to do.')).toBeInTheDocument();
    // No internal brand id anywhere on the page.
    expect(document.body.textContent).not.toMatch(/brd_demo|brd_new/);
    const nav = screen.getByRole('navigation', { name: 'Platform Console' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Overview', 'Brands', 'Retail network', 'Audit', 'System']);
  });
});

const brief = (over: Record<string, unknown>) => ({
  handoff_brief: null,
  next_action: null,
  used: [],
  source: 'AI',
  generated_at: '2026-10-05T09:00:00.000Z',
  latency_ms: 900,
  ...over,
});

describe('Ask Qwikspot (L7)', () => {
  it('"Network today" loads after the tiles, labelled, with its next action; it follows the period', async () => {
    const api = renderAt(
      '/platform',
      platformApi({
        '/api/platform/assistant/brief?days=7&include_history=true': brief({
          answer: 'In the last 7 days: 2 active brands. New Brand needs attention.',
          source: 'QUICK_SUMMARY',
          next_action: { label: 'Open the brands', page: 'BRANDS', path: '/platform/brands' },
        }),
      }),
    );
    expect(await screen.findByRole('region', { name: 'Across all brands' })).toBeInTheDocument();
    const card = (await screen.findByText(/New Brand needs attention\./)).closest('section')!;
    expect(within(card).getByText('Network today')).toBeInTheDocument();
    expect(within(card).getByText('Quick summary')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open the brands →' })).toHaveAttribute('href', '/platform/brands');
    fireEvent.click(screen.getByRole('button', { name: 'Live only' }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/platform/assistant/brief?days=7&include_history=false'),
    );
  });

  it('if the brief fails the Overview still renders, without the card', async () => {
    renderAt('/platform'); // no brief endpoint → it fails
    expect(await screen.findByRole('region', { name: 'Across all brands' })).toBeInTheDocument();
    // While it loads the card shows a skeleton; once the brief fails it is gone.
    await waitFor(() => expect(screen.queryByText('Network today')).not.toBeInTheDocument());
  });

  it('the header button opens the drawer with the 4 platform questions; answers link to the platform pages', async () => {
    const post = vi.fn(async () =>
      brief({
        answer: 'Skin Studio at Demo Beauty Co has stock data older than a day.',
        source: 'QUICK_SUMMARY',
        next_action: { label: 'Open the retail network', page: 'NETWORK', path: '/platform/network' },
        used: ['flagged_stores', 'audit'],
      }),
    );
    const api = renderAt('/platform/network', platformApi({}, post as unknown as ApiClient['post']));
    fireEvent.click(await screen.findByRole('button', { name: "Ask Qwikspot about the platform's data" }));
    const drawer = await screen.findByRole('dialog', { name: 'Ask Qwikspot' });
    expect(within(drawer).getByText(/only from the platform's Qwikspot data/)).toBeInTheDocument();
    const chips = within(within(drawer).getByRole('group', { name: 'Suggested questions' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual([
      'Which brands need attention?',
      "Which brand's setup is incomplete?",
      'Which stores have stock data older than a day?',
      'What changed in the audit log today?',
    ]);
    fireEvent.click(chips[2]!);
    expect(await within(drawer).findByText(/has stock data older than a day\./)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/platform/assistant', {
      question: 'Which stores have stock data older than a day?',
      page: 'NETWORK',
      days: 7,
      include_history: true,
    });
    expect(within(drawer).getByText('Quick summary')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Open the retail network →' })).toHaveAttribute(
      'href',
      '/platform/network',
    );
    expect(within(drawer).getByRole('link', { name: 'Retail network' })).toHaveAttribute('href', '/platform/network');
    expect(within(drawer).getByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '/platform/audit');
  });
});

describe('UI-P1: Brands', () => {
  it('the onboarding stepper: each step done (✓) or to do (○) with its count and a tooltip', async () => {
    renderAt('/platform/brands');
    const fresh = await screen.findByRole('article', { name: 'New Brand' });
    const steps = within(within(fresh).getByRole('list', { name: 'Onboarding' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent?.replace(/\s+/g, ' '))).toEqual([
      expect.stringContaining('Brand Admin'),
      expect.stringContaining('Catalogue'),
      expect.stringContaining('Stores with stock'),
      expect.stringContaining('SKU mapping'),
      expect.stringContaining('Retail Admins'),
      expect.stringContaining('Channel'),
    ]);
    expect(steps[0]).toHaveClass('pf-step--done');
    expect(steps[2]).toHaveClass('pf-step--todo');
    expect(steps[2]).toHaveTextContent('0 of 0');
    expect(steps[2]).toHaveTextContent('(to do)');
    expect(within(steps[2]!).getByRole('tooltip')).toHaveTextContent('0 of 0 stores have stock uploaded.');
    const demo = screen.getByRole('article', { name: 'Demo Beauty Co' });
    expect(
      within(demo)
        .getAllByRole('listitem')
        .filter((li) => li.classList.contains('pf-step--done')),
    ).toHaveLength(6);
  });

  it('"New brand" opens a drawer: name, create, a toast; Escape closes it', async () => {
    const post = vi.fn(async () => ({}));
    renderAt('/platform/brands', platformApi({}, post as unknown as ApiClient['post']));
    await screen.findByRole('article', { name: 'Demo Beauty Co' });
    expect(screen.queryByLabelText('New brand name')).not.toBeInTheDocument(); // no full-width form
    fireEvent.click(screen.getByRole('button', { name: 'New brand' }));
    const drawer = screen.getByRole('dialog', { name: 'New brand' });
    fireEvent.change(within(drawer).getByLabelText('New brand name'), { target: { value: 'Glow Labs' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Create brand' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/platform/brands', { name: 'Glow Labs' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New brand' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'New brand' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New brand' })).not.toBeInTheDocument();
  });

  it('provisioning from the brand card: the form opens in that card, for that brand; the hand-over link and Copy', async () => {
    const noAdmin: Brand = {
      ...BRANDS[1]!,
      brand_id: 'brd_glow',
      name: 'Glow Labs',
      brand_admin_user_id: null,
      onboarding: { ...ONBOARDING, brand_admin_provisioned: false },
    };
    const post = vi.fn(async () => ({
      user_id: 'u9',
      email: 'ops@glow.test',
      role: 'BRAND_ADMIN',
      password_setup_link: 'https://example.test/setup?oob=1',
    }));
    renderAt(
      '/platform/brands',
      platformApi({ '/api/platform/brands': { brands: [...BRANDS, noAdmin] } }, post as unknown as ApiClient['post']),
    );
    const card = await screen.findByRole('article', { name: 'Glow Labs' });
    expect(within(card).getByText('Provision its Brand Admin.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('article', { name: 'Demo Beauty Co' })).queryByRole('button', {
        name: 'Provision Brand Admin',
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Provision Brand Admin' }));
    fireEvent.change(within(card).getByLabelText('Brand Admin email for Glow Labs'), {
      target: { value: 'ops@glow.test' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Provision' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/platform/brands/brd_glow/admins', { email: 'ops@glow.test' }),
    );
    expect(await within(card).findByText('https://example.test/setup?oob=1')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('Suspend is in the "⋯" menu; Escape closes the menu and the confirm dialog', async () => {
    const patch = vi.fn(async () => ({}));
    const api = platformApi();
    api.patch = patch as unknown as ApiClient['patch'];
    renderAt('/platform/brands', api);
    const card = await screen.findByRole('article', { name: 'Demo Beauty Co' });
    expect(within(card).queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
    const more = within(card).getByRole('button', { name: 'More actions for Demo Beauty Co' });
    fireEvent.click(more);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Suspend' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Suspend Demo Beauty Co?' });
    expect(within(dialog).getByRole('button', { name: 'Suspend brand' })).toHaveClass('ui-button--danger');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('UI-P1: Retail network', () => {
  it('health chips count the stores; one filters the tables, clicking it again clears', async () => {
    renderAt('/platform/network?brand=brd_demo');
    const chips = await screen.findByRole('group', { name: 'Filter stores by health' });
    const noAdmin = within(chips).getByRole('button', { name: '1 No Store Admin' });
    expect(within(chips).getByRole('button', { name: '1 Healthy' })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: '0 Stale stock' })).toBeDisabled();
    fireEvent.click(noAdmin);
    expect(noAdmin).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Skin Studio')).toBeInTheDocument();
    expect(screen.queryByText('Wellness Mart')).not.toBeInTheDocument();
    expect(screen.queryByText('HealthPlus Chemist')).not.toBeInTheDocument();
    fireEvent.click(noAdmin);
    expect(screen.getByText('Wellness Mart')).toBeInTheDocument();
  });

  it('each flag pill explains itself on hover/focus; the flags card became a small popover', async () => {
    renderAt('/platform/network?brand=brd_demo');
    const row = (await screen.findByText('Skin Studio')).closest('tr')!;
    const pill = within(row).getByText('No Store Admin').closest('.ui-tip')!;
    expect(pill).toHaveAttribute('tabindex', '0');
    expect(document.getElementById(pill.getAttribute('aria-describedby')!)).toHaveTextContent(
      'Nobody can confirm holds at this store yet.',
    );
    expect(screen.queryByRole('heading', { name: 'What the flags mean' })).not.toBeInTheDocument();
    expect(screen.getByText('What do the flags mean?')).toBeInTheDocument();
  });

  it('with 4 brands or fewer the brand selector is tabs', async () => {
    renderAt('/platform/network?brand=brd_demo');
    const tabs = await screen.findByRole('tablist', { name: 'Brand' });
    expect(within(tabs).getByRole('tab', { name: 'Demo Beauty Co' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('UI-P1: shell and the Ask drawer', () => {
  it('the header names the role and the privacy rule; "?" shows the dismissed welcome note again', async () => {
    window.localStorage.removeItem('qs_role_banner_dismissed:PLATFORM');
    renderAt('/platform');
    expect(await screen.findByText('Platform Admin', { selector: '.shell-role' })).toBeInTheDocument();
    expect(screen.getByText('· Qwikspot team')).toBeInTheDocument();
    expect(screen.queryByText('Qwikspot platform')).not.toBeInTheDocument();
    const privacy = screen.getByText('Totals only · no customer data').closest('.ui-tip')!;
    expect(within(privacy as HTMLElement).getByRole('tooltip')).toHaveTextContent(
      'The platform never sees shoppers, phones, messages or stock lines',
    );
    const note = screen.getByRole('note');
    expect(within(note).getByRole('link', { name: 'Start with what needs attention' })).toHaveAttribute(
      'href',
      '/platform#attention',
    );
    fireEvent.click(within(note).getByRole('button', { name: 'Dismiss this note' }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the welcome note' }));
    expect(screen.getByRole('note')).toBeInTheDocument();
    expect(window.localStorage.getItem('qs_role_banner_dismissed:PLATFORM')).toBeNull();
  });

  it('the question box: Shift+Enter is a new line, Enter asks; chips sit in a grid; an example line before asking', async () => {
    const post = vi.fn(async () => brief({ answer: 'Two brands need attention.', source: 'AI' }));
    renderAt('/platform', platformApi({}, post as unknown as ApiClient['post']));
    fireEvent.click(await screen.findByRole('button', { name: "Ask Qwikspot about the platform's data" }));
    const drawer = await screen.findByRole('dialog', { name: 'Ask Qwikspot' });
    expect(within(drawer).getByText(/Or ask in your own words/)).toBeInTheDocument();
    const box = within(drawer).getByLabelText('Your question');
    expect(box.tagName).toBe('TEXTAREA');
    fireEvent.change(box, { target: { value: 'Which brand grew the most?' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(post).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/platform/assistant',
        expect.objectContaining({ question: 'Which brand grew the most?' }),
      ),
    );
    const answer = (await within(drawer).findByText('Two brands need attention.')).closest('article')!;
    expect(answer).toHaveClass('ask-answer');
    expect(within(answer).getByText('AI summary')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Ask Qwikspot' })).not.toBeInTheDocument();
  });
});

describe('UI-P1 follow-ups: AI actions, the flags popover, Refresh, the logo', () => {
  const asked = () => vi.fn(async () => brief({ answer: 'Skin Studio has no Store Admin.', source: 'QUICK_SUMMARY' }));

  it('"Ask about this network" opens Ask Qwikspot and asks about the stores', async () => {
    const post = asked();
    renderAt('/platform/network?brand=brd_demo', platformApi({}, post as unknown as ApiClient['post']));
    fireEvent.click(await screen.findByRole('button', { name: 'Ask about this network' }));
    const drawer = await screen.findByRole('dialog', { name: 'Ask Qwikspot' });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/platform/assistant',
        expect.objectContaining({ question: 'Which stores need attention, and why?', page: 'NETWORK' }),
      ),
    );
    expect(await within(drawer).findByText('Skin Studio has no Store Admin.')).toBeInTheDocument();
    // The drawer's header carries the Qwikspot mark.
    expect(drawer.querySelector('.ui-drawer__title .ui-ai-mark')).not.toBeNull();
  });

  it('"What changed today?" on Audit asks the audit question', async () => {
    const post = asked();
    renderAt('/platform/audit', platformApi({}, post as unknown as ApiClient['post']));
    fireEvent.click(await screen.findByRole('button', { name: 'What changed today?' }));
    await screen.findByRole('dialog', { name: 'Ask Qwikspot' });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/platform/assistant',
        expect.objectContaining({ question: 'What changed in the audit log today?', page: 'AUDIT' }),
      ),
    );
  });

  it('the header and page AI buttons are the Ask Qwikspot style with the logo', async () => {
    renderAt('/platform/network?brand=brd_demo');
    const header = await screen.findByRole('button', { name: "Ask Qwikspot about the platform's data" });
    expect(header).toHaveClass('ui-ai-button');
    expect(header.querySelector('.ui-ai-mark')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Ask about this network' })).toHaveClass('ui-ai-button');
  });

  it('the flags popover: one column, closes with ✕, with Escape and with a click outside', async () => {
    renderAt('/platform/network?brand=brd_demo');
    const trigger = await screen.findByRole('button', { name: 'What do the flags mean?' });
    fireEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'What the flags mean' });
    expect(panel.querySelector('dl')).toHaveClass('pf-popover__list');
    expect(within(panel).getByText('Nobody can confirm holds at this store yet.')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'What the flags mean' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'What the flags mean' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole('heading', { name: 'Retail network' }));
    expect(screen.queryByRole('dialog', { name: 'What the flags mean' })).not.toBeInTheDocument();
  });

  it('System → Refresh checks again and says when', async () => {
    const health = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            version: '1.4.0',
            commit: null,
            profile: 'gcp',
            adapters: { agent_runtime: 'GEMINI', channels: ['WHATSAPP'], commerce: 'SHOPIFY' },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', health);
    renderAt('/platform/system');
    expect(await screen.findByText(/^Checked at /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(health).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/^Checked at /)).toBeInTheDocument();
  });
});
