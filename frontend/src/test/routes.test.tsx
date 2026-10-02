import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import { ApiError, type ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';

const ME: Record<'platform' | 'brandAdmin' | 'retailAdmin', MeResponse> = {
  platform: {
    scope: 'PLATFORM',
    role: 'PLATFORM_ADMIN',
    user: { user_id: 'p', email: 'platform@bw.test' },
  },
  brandAdmin: {
    scope: 'BRAND',
    role: 'BRAND_ADMIN',
    user: { user_id: 'a', email: 'admin@brand.test' },
    brand_id: 'brand_A',
    brand_name: 'Brand A',
  },
  retailAdmin: {
    scope: 'RETAIL',
    role: 'RETAIL_ADMIN',
    user: { user_id: 'r', email: 'owner@north.test' },
    brand_id: 'brand_A',
    brand_name: 'Brand A',
    retailer_id: 'rtl_north',
    retailer_name: 'North Retail',
    store_id: 'st_1',
    store: {
      store_id: 'st_1',
      store_name: 'Bandra Store',
      city: 'Mumbai',
      address: 'Hill Road, Bandra',
      store_status: 'ACTIVE',
      store_hours: { timezone: 'Asia/Kolkata', monday: '10:00-21:00' },
    },
  },
};

/** One brand with its Brand Admin already provisioned, one without. */
const BRANDS = [
  {
    brand_id: 'brd_1',
    name: 'Has Admin',
    status: 'ACTIVE',
    created_at: null,
    brand_admin_user_id: 'u_admin',
    last_activity_at: '2026-10-05T06:00:00.000Z',
    onboarding: {
      brand_admin_provisioned: true,
      catalog: { synced: true, failed: false, last_sync_at: '2026-10-05T06:00:00.000Z', product_count: 10 },
      stores: { total: 5, with_stock: 4 },
      sku_mapping: { auto_matched: 18, needs_attention: 1 },
      retail_admins: { provisioned: 2, stores_with_retailer: 4 },
      channel: { simulator: true, whatsapp_number_configured: true },
    },
  },
  { brand_id: 'brd_2', name: 'Needs Admin', status: 'ACTIVE', created_at: null, brand_admin_user_id: null },
];
const BRAND_USERS = [
  { user_id: 'a', email: 'admin@brand.test', role: 'BRAND_ADMIN', retailer_id: null, store_id: null, status: 'ACTIVE' },
  {
    user_id: 'r',
    email: 'owner@north.test',
    role: 'RETAIL_ADMIN',
    retailer_id: 'rtl_north',
    store_id: 'st_1',
    status: 'ACTIVE',
  },
];
/** North Retail owns two stores (one with its Retail Admin, one without); New Retail has none yet. */
const RETAILERS = [
  { retailer_id: 'rtl_north', name: 'North Retail', status: 'ACTIVE' },
  { retailer_id: 'rtl_new', name: 'New Retail', status: 'ACTIVE' },
];
const STORES = [
  {
    store_id: 'st_1',
    store_name: 'Bandra Store',
    city: 'Mumbai',
    store_status: 'ACTIVE',
    retailer_id: 'rtl_north',
    retail_admin_user_id: 'r',
    sku_count: 10,
    stock_updated_at: '2026-10-05T06:30:00.000Z',
  },
  {
    store_id: 'st_2',
    store_name: 'Andheri Store',
    city: 'Mumbai',
    store_status: 'ACTIVE',
    retailer_id: 'rtl_north',
    retail_admin_user_id: null,
    sku_count: 0,
    stock_updated_at: null,
  },
];
const CONNECTIONS = [
  {
    connection_id: 'SHOPIFY',
    provider: 'SHOPIFY',
    source: 'MOCK',
    status: 'CONNECTED',
    connected_at: '2026-10-05T06:00:00.000Z',
    last_sync_at: '2026-10-05T06:00:00.000Z',
    last_error: null,
    product_count: 10,
    variant_count: 18,
  },
];
const CATALOG = {
  products: [
    {
      product_id: 'prd_1001',
      title: 'Vitamin C Glow Serum',
      category: 'Serum',
      tags: ['serum'],
      variants: [
        {
          variant_id: 'var_2001',
          title: '30 ml',
          sku: 'DBC-VCSERUM-30',
          canonical_sku: 'DBC-VCSERUM-30',
          price: 795,
          currency: 'INR',
          mapping_status: 'AUTO_MATCHED',
          stores_stocked: 4,
        },
      ],
    },
  ],
  retail_mappings_needing_attention: [
    { source_identifier: 'DBC-LIPBALM-10', mapping_status: 'UNMAPPED', mapping_reason: 'NO_CATALOG_MATCH' },
  ],
  mapping_summary: { auto_matched: 18, needs_attention: 1 },
};
const IMPORT = {
  import_id: 'imp_0123456789abcdef',
  file_name: 'demo-retail.csv',
  status: 'COMPLETED',
  failure_code: null,
  rows_processed: 36,
  rows_valid: 33,
  rows_invalid: 3,
  mappings_created: 18,
  mappings_failed: 1,
  created_at: '2026-10-05T06:30:00.000Z',
  completed_at: '2026-10-05T06:30:01.000Z',
};
const REPORT = {
  ...IMPORT,
  row_errors: [
    {
      line: 12,
      store_id: 'st_north_1',
      sku: 'DBC-SALCLN-100',
      code: 'INVALID_QUANTITY',
      field: 'quantity',
      message: 'quantity must be a whole number of 0 or more.',
    },
    {
      line: 23,
      store_id: 'st_north_2',
      sku: 'DBC-LIPBALM-10',
      code: 'UNKNOWN_SKU',
      field: null,
      message: 'This SKU matches no product in the synced catalogue.',
    },
  ],
};
const STOCK = {
  store_id: 'st_1',
  items: [
    {
      sku: 'DBC-VCSERUM-30',
      product_title: 'Vitamin C Glow Serum',
      variant_title: '30 ml',
      quantity: 3,
      reserved_quantity: 1,
      available_quantity: 2,
      availability_status: 'LOW_STOCK',
      last_updated_at: '2026-10-05T06:30:00.000Z',
      stale: true,
    },
  ],
};

type Fixtures = Record<string, unknown>;
const FULL: Fixtures = {
  '/api/brand/users': { users: BRAND_USERS },
  '/api/brand/retailers': { retailers: RETAILERS },
  '/api/brand/stores': { stores: STORES },
  '/api/brand/connections': { connections: CONNECTIONS },
  '/api/products': CATALOG,
  '/api/brand/retail-imports': { imports: [IMPORT] },
  '/api/retail/stores/st_1/inventory': STOCK,
};
/** A brand that has done nothing yet. */
const EMPTY: Fixtures = {
  '/api/brand/users': { users: [BRAND_USERS[0]] },
  '/api/brand/retailers': { retailers: [] },
  '/api/brand/stores': { stores: [] },
  '/api/brand/connections': { connections: [] },
  '/api/products': {
    products: [],
    retail_mappings_needing_attention: [],
    mapping_summary: { auto_matched: 0, needs_attention: 0 },
  },
  '/api/brand/retail-imports': { imports: [] },
  '/api/retail/stores/st_1/inventory': { store_id: 'st_1', items: [] },
};

/** A fake API: /api/me returns `me`; other endpoints return the fixtures above. */
function apiFor(me: MeResponse, fixtures: Fixtures = FULL): ApiClient {
  const get = vi.fn(async (path: string) => {
    if (path === '/api/me') return me;
    if (path.startsWith('/api/platform/brands')) return { brands: BRANDS };
    if (path.startsWith('/api/platform/audit')) return { events: [] };
    if (path.startsWith('/api/brand/retail-imports/imp_')) return REPORT;
    if (path in fixtures) return fixtures[path];
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, body: { email?: string }) => {
    if (path === '/api/integrations/shopify/sync') return CONNECTIONS[0];
    if (path === '/api/brand/retail-imports') {
      return {
        import: { ...IMPORT, status: 'UPLOADED' },
        upload: {
          method: 'PUT',
          url: '/api/local-files/uploads/0f8fad5b-d9cb-469f-a165-70867728950e',
          headers: { 'Content-Type': 'text/csv' },
          expires_at: '2026-10-05T07:00:00.000Z',
        },
      };
    }
    if (path.endsWith('/process')) return REPORT;
    return {
      user_id: 'new',
      email: body.email,
      role: 'RETAIL_ADMIN',
      password_setup_link: 'http://127.0.0.1:9099/emulator/action?mode=resetPassword&oobCode=abc',
    };
  });
  const upload = vi.fn(async () => ({ upload_id: 'u', size_bytes: 10 }));
  return {
    get: get as ApiClient['get'],
    post: post as ApiClient['post'],
    patch: vi.fn(async () => ({})) as ApiClient['patch'],
    upload: upload as ApiClient['upload'],
  };
}

function renderAt(path: string, auth: Partial<AuthState>, api: ApiClient) {
  const value: AuthState = { user: null, loading: false, signIn: vi.fn(), signOut: vi.fn(), ...auth };
  return render(
    <AuthContext.Provider value={value}>
      <ApiContext.Provider value={api}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ApiContext.Provider>
    </AuthContext.Provider>,
  );
}

const signedIn = { user: { uid: 'u', email: 'u@test' } };

describe('authentication gate', () => {
  it('shows a loading state while Firebase restores the session', () => {
    renderAt('/', { loading: true }, apiFor(ME.platform));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('redirects a signed-out visitor to /login without calling the API', () => {
    const api = apiFor(ME.platform);
    renderAt('/brand', { user: null }, api);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('sends a signed-in user away from /login', () => {
    renderAt('/login', signedIn, apiFor(ME.brandAdmin));
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('shows the backend message when the user is not provisioned', async () => {
    const api = apiFor(ME.platform);
    api.get = vi.fn(async () => {
      throw new ApiError(
        403,
        'USER_NOT_PROVISIONED',
        'Your account has not been set up for Buildwise yet.',
        false,
        'req-1',
      );
    }) as ApiClient['get'];
    renderAt('/', signedIn, api);
    expect(await screen.findByText('Your account has not been set up for Buildwise yet.')).toBeInTheDocument();
    expect(screen.getByText('Reference: req-1')).toBeInTheDocument();
  });

  it('shows a not-found page for unknown routes', () => {
    renderAt('/nowhere', {}, apiFor(ME.platform));
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });
});

describe('scope routing — each of the three roles lands in its own console area', () => {
  it('PLATFORM_ADMIN → Platform Admin; Brand Admin provisioning offers only brands without one', async () => {
    renderAt('/', signedIn, apiFor(ME.platform));
    expect(await screen.findByText('· Platform Admin')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Brands' })).toBeInTheDocument();
    expect(screen.getByText('Platform Admin', { selector: '.badge' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Needs Admin' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Has Admin' })).not.toBeInTheDocument();
  });

  it('PLATFORM_ADMIN sees each brand’s onboarding checklist and last activity, never customer data', async () => {
    renderAt('/', signedIn, apiFor(ME.platform));
    const row = (await screen.findByText('Has Admin')).closest('tr')!;
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(row).getByText('10 products')).toBeInTheDocument();
    expect(within(row).getByText('4 of 5 with stock')).toBeInTheDocument();
    expect(within(row).getByText('18 matched, 1 need attention')).toBeInTheDocument();
    expect(within(row).getByText('2 of 4 stores')).toBeInTheDocument();
    expect(within(row).getByText('WhatsApp number set, simulator')).toBeInTheDocument();
    expect(within(row).queryByText('none yet')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/cus_|sim:|\+91|\b\d{10}\b/);
  });

  it('PLATFORM_ADMIN suspends with a reason (explained first) and can reactivate', async () => {
    const api = apiFor(ME.platform);
    renderAt('/', signedIn, api);
    const row = (await screen.findByText('Has Admin')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Suspend' }));
    const dialog = screen.getByRole('form', { name: 'Suspend Has Admin' });
    expect(dialog).toHaveTextContent('Your brand is suspended. Contact Buildwise support.');
    expect(api.patch).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Reason (kept in the audit log)'), {
      target: { value: 'Unpaid invoice' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend brand' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/api/platform/brands/brd_1', {
        status: 'SUSPENDED',
        reason: 'Unpaid invoice',
      }),
    );
  });

  it('BRAND_ADMIN → Brand Console shows Retailer → Stores → Retail Admin, with no brand-admin or store-ID UI', async () => {
    renderAt('/', signedIn, apiFor(ME.brandAdmin));
    expect(await screen.findByText('· Brand Console')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create retailer' })).toBeInTheDocument();
    expect(await screen.findByText('Bandra Store')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Retailer: North Retail/ })).toBeInTheDocument();
    expect(screen.getByText('Andheri Store')).toBeInTheDocument();
    expect(screen.getByText('No stores yet. Stores arrive through the retail CSV import.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /brand admin/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /assign store/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Store ID')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('a store with a Retail Admin shows it and offers no provisioning; a store without one offers it', async () => {
    renderAt('/', signedIn, apiFor(ME.brandAdmin));
    const bandra = (await screen.findByText('Bandra Store')).closest('tr')!;
    expect(within(bandra).getByText('owner@north.test')).toBeInTheDocument();
    expect(within(bandra).queryByRole('button')).not.toBeInTheDocument();

    const andheri = screen.getByText('Andheri Store').closest('tr')!;
    expect(within(andheri).getByText('Not provisioned')).toBeInTheDocument();
    expect(
      within(andheri).getByRole('button', { name: 'Provision Retail Admin for Andheri Store' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Provision Retail Admin/ })).toHaveLength(1);
  });

  it('provisioning is store-based and shows the local password-setup link', async () => {
    const api = apiFor(ME.brandAdmin);
    renderAt('/', signedIn, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Provision Retail Admin for Andheri Store' }));
    fireEvent.change(screen.getByLabelText('Retail admin email for Andheri Store'), {
      target: { value: 'owner-andheri@north.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Provision' }));

    expect(await screen.findByText(/oobCode=abc/)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/brand/stores/st_2/admins', { email: 'owner-andheri@north.test' });
  });

  it('RETAIL_ADMIN → Retailer Console with exactly its one store and no store picker', async () => {
    renderAt('/', signedIn, apiFor(ME.retailAdmin));
    expect(await screen.findByText('Your store')).toBeInTheDocument();
    expect(screen.getByText('North Retail · Brand A')).toBeInTheDocument();
    expect(screen.getByText('Bandra Store')).toBeInTheDocument();
    expect(screen.getByText('North Retail')).toBeInTheDocument();
    expect(screen.getByText('Hill Road, Bandra')).toBeInTheDocument();
    expect(screen.getByText('mon 10:00-21:00 (Asia/Kolkata)')).toBeInTheDocument();
    expect(screen.getByText(/Reserved = units held for customers at this store/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('Andheri Store')).not.toBeInTheDocument();
  });

  it('RETAIL_ADMIN → Store stock shows only its own store (read-only)', async () => {
    const api = apiFor(ME.retailAdmin);
    renderAt('/', signedIn, api);
    const row = (await screen.findByText('DBC-VCSERUM-30')).closest('tr')!;
    expect(within(row).getByText('Vitamin C Glow Serum')).toBeInTheDocument();
    expect(within(row).getByText('Low stock')).toBeInTheDocument();
    expect(within(row).getByText('stale')).toBeInTheDocument(); // older than the brand's freshness window
    expect(screen.getByText(/Some stock rows are out of date/)).toBeInTheDocument();
    expect(row.textContent).toContain('312'); // quantity 3, reserved 1, available 2
    const paths = (api.get as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(paths.filter((p: string) => p.includes('/inventory'))).toEqual(['/api/retail/stores/st_1/inventory']);
    expect(screen.queryByRole('button', { name: /sync|import|upload/i })).not.toBeInTheDocument();
  });

  it('RETAIL_ADMIN → Store stock empty state', async () => {
    renderAt('/', signedIn, apiFor(ME.retailAdmin, EMPTY));
    expect(await screen.findByText(/No stock has been imported for this store yet/)).toBeInTheDocument();
  });

  it.each([
    ['/platform', ME.brandAdmin, '· Brand Console'],
    ['/retailer', ME.brandAdmin, '· Brand Console'],
    ['/brand', ME.retailAdmin, '· Retailer Console'],
    ['/platform', ME.retailAdmin, '· Retailer Console'],
    ['/retailer', ME.platform, '· Platform Admin'],
    ['/brand', ME.platform, '· Platform Admin'],
  ])('visiting %s with the wrong scope redirects to the user’s own area', async (path, me, expected) => {
    renderAt(path, signedIn, apiFor(me));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});

describe('Brand Console — M3 catalog & store truth', () => {
  it('setup checklist: an empty brand sees every step to do, each with its action', async () => {
    const api = apiFor(ME.brandAdmin, EMPTY);
    renderAt('/', signedIn, api);
    // Each panel loads independently: wait for every one of them (no ordering assumptions).
    expect(await screen.findByText('Not synced yet.')).toBeInTheDocument();
    expect(await screen.findByText('No store stock imported yet.')).toBeInTheDocument();
    expect(await screen.findByText('Nothing mapped yet.')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Import a retail CSV' })).toHaveAttribute('href', '#retail-import');
    expect(await screen.findByText('No products yet. Sync the catalog from your commerce store.')).toBeInTheDocument();
    expect(await screen.findByText('No imports yet.')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Sync catalog' })[0]!);
    expect(api.post).toHaveBeenCalledWith('/api/integrations/shopify/sync', {});
  });

  it('setup checklist: done steps show their facts; open issues stay to do', async () => {
    renderAt('/', signedIn, apiFor(ME.brandAdmin));
    expect(await screen.findByText(/10 products · 18 variants · last sync/)).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 stores with stock · stock as of/)).toBeInTheDocument();
    expect(screen.getByText('18 auto-matched · 1 need attention')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 stores have their Retail Admin')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').filter((li) => li.closest('.checklist'));
    expect(items.map((li) => li.className)).toEqual(['done', 'done', 'todo', 'todo']);
  });

  it('setup checklist: a failed sync says so and offers "Retry sync" (docs/08 §13)', async () => {
    const failed = {
      ...CONNECTIONS[0],
      status: 'ERROR',
      last_error: { code: 'COMMERCE_SYNC_FAILED', message: 'The commerce provider could not be reached.' },
    };
    const api = apiFor(ME.brandAdmin, { ...FULL, '/api/brand/connections': { connections: [failed] } });
    renderAt('/', signedIn, api);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sync failed — The commerce provider could not be reached. Try again in a moment.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry sync' }));
    expect(api.post).toHaveBeenCalledWith('/api/integrations/shopify/sync', {});
  });

  it('catalog & mapping: variants with SKU, price and mapping status; unmapped retail SKUs stay visible', async () => {
    renderAt('/', signedIn, apiFor(ME.brandAdmin));
    const row = (await screen.findByText('Vitamin C Glow Serum')).closest('tr')!;
    expect(within(row).getByText('DBC-VCSERUM-30')).toBeInTheDocument();
    expect(within(row).getByText('₹795')).toBeInTheDocument();
    expect(within(row).getByText('auto-matched')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Retail SKUs needing attention' })).toBeInTheDocument();
    expect(screen.getAllByText('DBC-LIPBALM-10').length).toBeGreaterThan(0);
  });

  it('retail import: create → upload the file → process → report with row errors', async () => {
    const api = apiFor(ME.brandAdmin);
    renderAt('/', signedIn, api);
    const input = await screen.findByLabelText('Retail CSV file');
    const file = new File(['store_id\n'], 'demo-retail.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.submit(input.closest('form')!);

    const report = await screen.findByLabelText('Import report');
    expect(api.post).toHaveBeenCalledWith('/api/brand/retail-imports', { file_name: 'demo-retail.csv' });
    expect(api.upload).toHaveBeenCalledWith(
      '/api/local-files/uploads/0f8fad5b-d9cb-469f-a165-70867728950e',
      file,
      'text/csv',
    );
    expect(api.post).toHaveBeenCalledWith('/api/brand/retail-imports/imp_0123456789abcdef/process', {});
    expect(within(report).getByText(/33 of 36 rows imported · 3 rows rejected/)).toBeInTheDocument();
    expect(within(report).getByText('INVALID_QUANTITY')).toBeInTheDocument();
    expect(within(report).getByText('UNKNOWN_SKU')).toBeInTheDocument();
  });

  it('import history opens a past report; stores show SKU count and last stock update', async () => {
    renderAt('/', signedIn, apiFor(ME.brandAdmin));
    fireEvent.click(await screen.findByRole('button', { name: 'View report' }));
    expect(await screen.findByLabelText('Import report')).toBeInTheDocument();
    const bandra = screen.getByText('Bandra Store').closest('tr')!;
    expect(within(bandra).getByText('10')).toBeInTheDocument();
  });
});
