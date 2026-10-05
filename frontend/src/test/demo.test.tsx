import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import { ApiError, type ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import { label } from '../lib/labels';

/** M7 judge experience: demo logins, the demo guide + Reset demo, shared-demo safety, labels. */

const BRAND_ADMIN: MeResponse = {
  scope: 'BRAND',
  role: 'BRAND_ADMIN',
  user: { user_id: 'a', email: 'admin@demo-brand.test' },
  brand_id: 'brd_demo',
  brand_name: 'Demo Beauty Co',
};

const BRAND_FIXTURES: Record<string, unknown> = {
  '/api/me': BRAND_ADMIN,
  '/api/brand/users': { users: [] },
  '/api/brand/retailers': { retailers: [] },
  '/api/brand/stores': { stores: [] },
  '/api/brand/connections': { connections: [] },
  '/api/products': {
    products: [],
    retail_mappings_needing_attention: [],
    mapping_summary: { auto_matched: 0, needs_attention: 0 },
  },
  '/api/brand/retail-imports': { imports: [] },
  '/api/brand/conversations': { conversations: [] },
  '/api/brand/intents': { intents: [] },
};

function apiWith(extra: Record<string, unknown>, post = vi.fn(async () => ({}))): ApiClient {
  const fixtures = { ...BRAND_FIXTURES, ...extra };
  return {
    get: vi.fn(async (path: string) => {
      if (path in fixtures) return fixtures[path];
      throw new Error(`unexpected GET ${path}`);
    }) as ApiClient['get'],
    post: post as ApiClient['post'],
    patch: vi.fn() as ApiClient['patch'],
    upload: vi.fn() as ApiClient['upload'],
  };
}

function renderAt(path: string, api: ApiClient, auth: Partial<AuthState> = { user: { uid: 'u', email: 'u@test' } }) {
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

const LOGINS = [
  {
    email: 'admin@demo-brand.test',
    password: 'pw-from-api',
    role: 'BRAND_ADMIN',
    title: 'Brand Admin — Demo Beauty Co',
    hint: 'Start here.',
  },
  {
    email: 'retail-admin-north-2@qwikspot.test',
    password: 'pw-from-api',
    role: 'RETAIL_ADMIN',
    title: 'Retail Admin — Andheri Store',
    hint: 'Complete holds.',
  },
];

function mockDemoConfig(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('login page — "Try the demo" (DEMO_MODE)', () => {
  it('shows the demo logins from GET /api/demo/config; "Use" fills the form', async () => {
    const fetchMock = mockDemoConfig({ demo_mode: true, logins: LOGINS });
    renderAt('/login?as=store', apiWith({}), { user: null });
    const panel = await screen.findByRole('region', { name: 'Try the demo' });
    expect(fetchMock).toHaveBeenCalledWith('/api/demo/config');
    expect(within(panel).getByText('Retail Admin — Andheri Store')).toBeInTheDocument();
    expect(within(panel).getByText('Retail Admin')).toBeInTheDocument(); // a label, not RETAIL_ADMIN
    fireEvent.click(within(panel).getByRole('button', { name: 'Use Retail Admin — Andheri Store' }));
    expect(screen.getByLabelText('Email')).toHaveValue('retail-admin-north-2@qwikspot.test');
    expect(screen.getByLabelText('Password')).toHaveValue('pw-from-api');
  });

  it('DEMO_MODE off → no panel and no password anywhere on the page', async () => {
    const fetchMock = mockDemoConfig({ demo_mode: false });
    renderAt('/login', apiWith({}), { user: null });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Try the demo' })).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('qwikspot-demo-1');
  });

  it('an unreachable config simply hides the panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    renderAt('/login', apiWith({}), { user: null });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Try the demo' })).not.toBeInTheDocument();
  });
});

describe('Brand Console — demo guide and Reset demo', () => {
  it('the demo brand sees the 8-step judge script; Reset asks first, then resets and reports', async () => {
    const post = vi.fn(async () => ({
      brand_id: 'brd_demo',
      catalog: { products: 10, variants: 18 },
      stock: { status: 'COMPLETED', rows_valid: 34 },
      history: { outcomes: 97 },
    }));
    renderAt('/brand', apiWith({ '/api/brand/demo': { reset_available: true } }, post));
    const guide = (await screen.findByText('Demo guide')).closest('details')!;
    expect(within(guide).getAllByRole('listitem')).toHaveLength(8);
    expect(within(guide).getByRole('link', { name: 'Open a platform sign-in tab' })).toHaveAttribute(
      'href',
      '/login?as=platform',
    );
    const open = within(guide).getByRole('link', { name: 'Open the shopper demo' });
    expect(open).toHaveAttribute('href', '/shop?brand=brd_demo');
    expect(open).toHaveAttribute('target', '_blank');
    // The header offers the shopper demo too (DEMO_MODE, demo brand only).
    expect(screen.getByRole('link', { name: /Open shopper demo/ })).toHaveAttribute('href', '/shop?brand=brd_demo');

    fireEvent.click(within(guide).getByRole('button', { name: 'Reset demo' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('This resets the shared demo for everyone.');
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, reset the demo' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/brand/demo/reset', {}));
    expect(await screen.findByText(/Demo reset: 10 products synced/)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it("a second Reset within a minute shows the server's words and its code", async () => {
    const post = vi.fn(async () => {
      throw new ApiError(429, 'RATE_LIMITED', 'The demo was just reset. Try again in a minute.', true, 'req_1');
    });
    renderAt('/brand', apiWith({ '/api/brand/demo': { reset_available: true } }, post));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset demo' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Yes, reset the demo' }));
    expect(
      await screen.findByText('The demo was just reset. Try again in a minute. (RATE_LIMITED)'),
    ).toBeInTheDocument();
  });

  it('Cancel closes the dialog without resetting; a brand that is not the demo brand sees no guide', async () => {
    const post = vi.fn(async () => ({}));
    const view = renderAt('/brand', apiWith({ '/api/brand/demo': { reset_available: true } }, post));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset demo' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    view.unmount();

    renderAt('/brand', apiWith({ '/api/brand/demo': { reset_available: false } }));
    expect(await screen.findByRole('heading', { name: 'Setup checklist' })).toBeInTheDocument();
    expect(screen.queryByText('Demo guide')).not.toBeInTheDocument();
  });
});

describe('Brand Console transcript — delivery status', () => {
  it('a message the channel could not deliver says "Not delivered"; no simulator anywhere', async () => {
    const row = {
      conversation_id: 'conv_1',
      customer_ref: 'sim:judge_ab12',
      channel: 'SIMULATOR',
      status: 'OPEN',
      human_handoff: false,
      last_message_at: '2026-10-05T10:03:00.000Z',
      last_message_preview: 'Hello',
      intent: null,
    };
    const message = (id: string, direction: 'INBOUND' | 'OUTBOUND', delivery: string) => ({
      message_id: id,
      direction,
      message_type: 'TEXT',
      text: direction === 'INBOUND' ? 'Hello' : 'Hi from Demo Beauty Co',
      options: null,
      location: null,
      origin: direction === 'INBOUND' ? 'CUSTOMER' : 'AUTOMATED_REPLY',
      message_kind: direction === 'INBOUND' ? null : 'SESSION',
      template_name: null,
      delivery_status: delivery,
      timestamp: '2026-10-05T10:03:00.000Z',
    });
    const api = apiWith({
      '/api/brand/conversations': { conversations: [row] },
      '/api/brand/conversations/conv_1': {
        ...row,
        messages: [message('m1', 'INBOUND', 'RECEIVED'), message('m2', 'OUTBOUND', 'FAILED')],
        recommendations: [],
      },
    });
    renderAt('/brand/conversations', api);
    fireEvent.click(await screen.findByRole('button', { name: /sim:judge_ab12/ }));
    const transcript = await screen.findByRole('log', { name: 'Messages' });
    expect(await within(transcript).findByText(/Not delivered/)).toBeInTheDocument();
    expect(within(transcript).getByText('AI assistant')).toBeInTheDocument();
    expect(screen.queryByLabelText('Simulator customer')).not.toBeInTheDocument();
  });
});

describe('labels people read', () => {
  it('enums become words', () => {
    expect(label('HIGH_INTENT')).toBe('High intent');
    expect(label('RETAIL_ADMIN')).toBe('Retail Admin');
    expect(label('CUSTOMER_ARRIVED')).toBe('Customer arrived');
    expect(label(null)).toBe('—');
  });
});
