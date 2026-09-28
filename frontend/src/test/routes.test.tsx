import { fireEvent, render, screen, within } from '@testing-library/react';
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
  { brand_id: 'brd_1', name: 'Has Admin', status: 'ACTIVE', created_at: null, brand_admin_user_id: 'u_admin' },
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
  },
  {
    store_id: 'st_2',
    store_name: 'Andheri Store',
    city: 'Mumbai',
    store_status: 'ACTIVE',
    retailer_id: 'rtl_north',
    retail_admin_user_id: null,
  },
];

/** A fake API: /api/me returns `me`; list endpoints return the fixtures above. */
function apiFor(me: MeResponse): ApiClient {
  const get = vi.fn(async (path: string) => {
    if (path === '/api/me') return me;
    if (path.startsWith('/api/platform/brands')) return { brands: BRANDS };
    if (path.startsWith('/api/platform/audit')) return { events: [] };
    if (path === '/api/brand/users') return { users: BRAND_USERS };
    if (path === '/api/brand/retailers') return { retailers: RETAILERS };
    if (path === '/api/brand/stores') return { stores: STORES };
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (_path: string, body: { email?: string }) => ({
    user_id: 'new',
    email: body.email,
    role: 'RETAIL_ADMIN',
    password_setup_link: 'http://127.0.0.1:9099/emulator/action?mode=resetPassword&oobCode=abc',
  }));
  return { get: get as ApiClient['get'], post: post as ApiClient['post'], patch: vi.fn() as ApiClient['patch'] };
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
    expect(screen.getByText('PLATFORM_ADMIN')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Needs Admin' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Has Admin' })).not.toBeInTheDocument();
  });

  it('BRAND_ADMIN → Brand Console shows Retailer → Stores → Retail Admin, with no brand-admin or store-ID UI', async () => {
    renderAt('/', signedIn, apiFor(ME.brandAdmin));
    expect(await screen.findByText('· Brand Console')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create retailer' })).toBeInTheDocument();
    expect(await screen.findByText('Bandra Store')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Retailer: North Retail/ })).toBeInTheDocument();
    expect(screen.getByText('Andheri Store')).toBeInTheDocument();
    expect(screen.getByText('No stores yet. Stores arrive through retail data import.')).toBeInTheDocument();
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
    expect(screen.getByText(/inventory and customer reservations appear here/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('Andheri Store')).not.toBeInTheDocument();
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
