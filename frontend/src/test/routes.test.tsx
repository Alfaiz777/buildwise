import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import { ApiError, type ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';

const ME: MeResponse = {
  user: { user_id: 'u1', email: 'admin@brand.test', role: 'BRAND_ADMIN', store_ids: [] },
  brand: { brand_id: 'brand_A', name: 'Brand A' },
};

function renderAt(path: string, auth: Partial<AuthState>, api: ApiClient) {
  const value: AuthState = {
    user: null,
    loading: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
    ...auth,
  };
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

const okApi: ApiClient = { get: vi.fn(async () => ME) as ApiClient['get'] };

describe('protected route', () => {
  it('shows a loading state while Firebase restores the session', () => {
    renderAt('/', { loading: true }, okApi);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('redirects a signed-out visitor to /login without calling the API', () => {
    const api: ApiClient = { get: vi.fn() as ApiClient['get'] };
    renderAt('/', { user: null }, api);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('renders the brand and role from GET /api/me for a signed-in user', async () => {
    renderAt('/', { user: { uid: 'u1', email: 'admin@brand.test' } }, okApi);
    expect(await screen.findByText('Brand A')).toBeInTheDocument();
    expect(screen.getByText('BRAND_ADMIN')).toBeInTheDocument();
    expect(okApi.get).toHaveBeenCalledWith('/api/me');
  });

  it('shows the backend message when the user is not provisioned', async () => {
    const api: ApiClient = {
      get: vi.fn(async () => {
        throw new ApiError(403, 'USER_NOT_PROVISIONED', 'Your account has not been set up for Buildwise yet.', false, 'req-1');
      }) as ApiClient['get'],
    };
    renderAt('/', { user: { uid: 'u2', email: 'x@y.test' } }, api);
    expect(await screen.findByText('Your account has not been set up for Buildwise yet.')).toBeInTheDocument();
    expect(screen.getByText('Reference: req-1')).toBeInTheDocument();
  });

  it('sends a signed-in user away from /login', () => {
    renderAt('/login', { user: { uid: 'u1', email: 'admin@brand.test' } }, okApi);
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('shows a not-found page for unknown routes', () => {
    renderAt('/nowhere', {}, okApi);
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });
});
