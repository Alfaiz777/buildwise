import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import { ApiError, type ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import { expiresIn, storeTime } from '../pages/retailer/RetailerQueue';
import { waitingFor } from '../pages/brand/HandoffPanel';
import SNIPPET from '../../public/qwikspot-intent.js?raw';

const RETAIL: MeResponse = {
  scope: 'RETAIL',
  role: 'RETAIL_ADMIN',
  user: { user_id: 'r', email: 'owner@north.test' },
  brand_id: 'brand_A',
  brand_name: 'Brand A',
  retailer_id: 'rtl_north',
  retailer_name: 'North Retail',
  store_id: 'st_2',
  store: {
    store_id: 'st_2',
    store_name: 'Andheri Store',
    city: 'Mumbai',
    address: 'Lokhandwala Complex',
    store_status: 'ACTIVE',
    store_hours: { timezone: 'Asia/Kolkata', monday: '10:00-21:00' },
  },
};
const BRAND: MeResponse = {
  scope: 'BRAND',
  role: 'BRAND_ADMIN',
  user: { user_id: 'a', email: 'admin@brand.test' },
  brand_id: 'brand_A',
  brand_name: 'Brand A',
};

const in40 = () => new Date(Date.now() + 40 * 60_000).toISOString();
const reservation = (over: Record<string, unknown> = {}) => ({
  reservation_id: 'res_1',
  store_name: 'Andheri Store',
  store_timezone: 'Asia/Kolkata',
  product_title: 'Vitamin C Glow Serum',
  variant_title: '30 ml',
  sku: 'DBC-VCSERUM-30',
  quantity: 1,
  status: 'PENDING',
  allowed_actions: ['CONFIRMED', 'CANCELLED'],
  pickup_code_locked: false,
  customer_display: 'Customer •••• 4821',
  customer_eta: null,
  created_at: new Date().toISOString(),
  expires_at: in40(),
  cancelled_by: null,
  cancel_reason: null,
  last_notification: null,
  ...over,
});

function render_(path: string, api: ApiClient) {
  const auth: AuthState = { user: { uid: 'u', email: 'u@test' }, loading: false, signIn: vi.fn(), signOut: vi.fn() };
  return render(
    <AuthContext.Provider value={auth}>
      <ApiContext.Provider value={api}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ApiContext.Provider>
    </AuthContext.Provider>,
  );
}

function client(
  get: (path: string) => unknown,
  patch?: (path: string, body: unknown) => unknown,
  post?: (path: string, body: unknown) => unknown,
): ApiClient {
  return {
    get: vi.fn(async (p: string) => get(p)) as ApiClient['get'],
    post: vi.fn(async (p: string, b: unknown) => (post ? post(p, b) : {})) as ApiClient['post'],
    patch: vi.fn(async (p: string, b: unknown) => (patch ? patch(p, b) : {})) as ApiClient['patch'],
    upload: vi.fn() as ApiClient['upload'],
  };
}

describe('Retailer Console — reservation queue (M6)', () => {
  it('shows the card with masked customer and store-time hold; Confirm sends expected_current_status and shows "Next up"', async () => {
    let state = 'PENDING';
    const api = client(
      (p) => {
        if (p === '/api/me') return RETAIL;
        if (p.startsWith('/api/reservations?view=active'))
          return {
            reservations:
              state === 'PENDING'
                ? [reservation()]
                : [reservation({ status: 'CONFIRMED', allowed_actions: ['READY', 'CANCELLED'] })],
          };
        if (p.startsWith('/api/reservations?view=history')) return { reservations: [] };
        if (p.endsWith('/summary')) return { days: 7, reservations: 3, completed: 1, refused: 1, expired: 0 };
        if (p.endsWith('/inventory')) return { items: [] };
        throw new Error(`unexpected GET ${p}`);
      },
      (_p, body) => {
        state = 'CONFIRMED';
        expect(body).toEqual({ status: 'CONFIRMED', expected_current_status: 'PENDING' });
        return { ...reservation({ status: 'CONFIRMED' }), notification: { status: 'SENT' } };
      },
    );
    render_('/retailer', api);
    const card = await screen.findByRole('article', { name: '1 × Vitamin C Glow Serum 30 ml' });
    const strip = await screen.findByRole('region', { name: 'Last 7 days' });
    expect(within(strip).getByText('Holds').parentElement).toHaveTextContent('3');
    expect(within(strip).getByText('Picked up').parentElement).toHaveTextContent('1');
    // The most urgent hold is the "Next up" card.
    expect(within(screen.getByRole('region', { name: 'Next up' })).getByRole('article')).toBe(card);
    expect(within(card).getByText(/Customer •••• 4821/)).toBeInTheDocument();
    expect(within(card).getByText(/expires in (39|40) min/)).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/@|\+91|phone/);
    fireEvent.click(within(card).getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText(/Confirmed \(customer notified\)\. Next up: 1 × Vitamin C Glow Serum 30 ml, expires in/),
    ).toBeInTheDocument();
  });

  it('Complete needs the 6-digit code; a refusal needs a reason, OTHER asks for an internal note', async () => {
    const api = client((p) => {
      if (p === '/api/me') return RETAIL;
      if (p.startsWith('/api/reservations'))
        return {
          reservations: [
            reservation({ reservation_id: 'res_a', status: 'CUSTOMER_ARRIVED', allowed_actions: ['COMPLETED'] }),
            reservation({ reservation_id: 'res_b', product_title: 'Niacinamide Serum' }),
          ],
        };
      if (p.endsWith('/summary')) return { days: 7, reservations: 0, completed: 0, refused: 0, expired: 0 };
      return { items: [] };
    });
    render_('/retailer', api);
    const complete = await screen.findByRole('button', { name: 'Complete' });
    expect(complete).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Pickup code for/), { target: { value: '00a4271' } });
    expect(screen.getByLabelText(/Pickup code for/)).toHaveValue('004271');
    expect(complete).toBeEnabled();
    const refuse = screen.getByRole('button', { name: 'Refuse' });
    expect(refuse).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Refusal reason for 1 × Niacinamide/), { target: { value: 'OTHER' } });
    expect(screen.getByLabelText('Internal note (not shown to the customer)')).toBeInTheDocument();
    expect(refuse).toBeEnabled();
  });

  it('a wrong code shows the error; an opted-out customer is visible on the card', async () => {
    const api = client(
      (p) => {
        if (p === '/api/me') return RETAIL;
        if (p.startsWith('/api/reservations'))
          return {
            reservations: [
              reservation({
                status: 'CUSTOMER_ARRIVED',
                allowed_actions: ['COMPLETED'],
                last_notification: { status: 'NOT_SENT_OPTED_OUT', event: 'READY', message_kind: null, at: '' },
              }),
            ],
          };
        if (p.endsWith('/summary')) return { days: 7, reservations: 1, completed: 0, refused: 0, expired: 0 };
        return { items: [] };
      },
      () => {
        throw new ApiError(
          422,
          'PICKUP_CODE_MISMATCH',
          "The pickup code doesn't match. Ask the customer to show it again.",
          false,
          null,
        );
      },
    );
    render_('/retailer', api);
    expect(await screen.findByTestId('notification')).toHaveTextContent('customer opted out; not notified');
    fireEvent.change(screen.getByLabelText(/Pickup code for/), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("The pickup code doesn't match");
  });

  it('helpers: store-time formatting and countdown', () => {
    expect(storeTime('2026-10-07T08:30:00.000Z', 'Asia/Kolkata')).toBe('14:00');
    const now = Date.parse('2026-10-07T08:00:00.000Z');
    expect(expiresIn('2026-10-07T08:40:00.000Z', now)).toBe('expires in 40 min');
    expect(expiresIn('2026-10-07T09:30:00.000Z', now)).toBe('expires in 1 h 30 min');
    expect(expiresIn('2026-10-07T07:00:00.000Z', now)).toBe('expiring now');
    expect(waitingFor('2026-10-07T07:48:00.000Z', now)).toBe('waiting 12 min');
    expect(waitingFor(null, now)).toBeNull();
  });
});

const ROW = {
  conversation_id: 'conv_1',
  customer_ref: 'sim:c1',
  channel: 'SIMULATOR',
  status: 'OPEN',
  human_handoff: true,
  handoff_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  last_message_at: null,
  last_inbound_at: null,
  intent: null,
};

describe('Brand Console — handoff queue (M6)', () => {
  it('shows the waiting time, replies as a person, and resolves back to the assistant', async () => {
    const api = client(
      (p) => {
        if (p === '/api/me') return BRAND;
        if (p === '/api/brand/conversations') return { conversations: [ROW] };
        if (p === '/api/brand/intents') return { intents: [] };
        if (p === '/api/brand/conversations/conv_1')
          return { ...ROW, brand_display_name: 'Demo Co', web_events: [], messages: [], recommendations: [] };
        throw new Error(p);
      },
      undefined,
      (p) => (p.endsWith('/resolve') ? { human_handoff: false } : { message_id: 'm1', origin: 'HUMAN_AGENT' }),
    );
    render_('/brand/conversations', api);
    fireEvent.click(await screen.findByRole('button', { name: /sim:c1/ }));
    expect(screen.getByText(/needs a person · waiting 12 min/)).toBeInTheDocument();
    const panel = await screen.findByLabelText('Needs a person');
    fireEvent.change(within(panel).getByLabelText('Reply as a person'), { target: { value: 'Hi, Meera here.' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send reply' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/brand/conversations/conv_1/replies', { text: 'Hi, Meera here.' }),
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Resolve and return to assistant' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/brand/conversations/conv_1/resolve', {}));
  });
});

const INSIGHTS = {
  period: { days: 7, from: '', to: '', timezone: 'Asia/Kolkata' },
  demo_history: { included: true, records: 412 },
  funnel: {
    intents: 40,
    follow_ups_sent: 9,
    conversations: 14,
    store_recommendations: 30,
    reservations: 12,
    completed: 7,
    outcomes: { ONLINE: 3, OFFLINE: 7, ALTERNATIVE: 0, NONE: 20 },
  },
  conversion_by_action: [
    {
      action: 'STORE_RESERVATION',
      intended: ['OFFLINE'],
      outcomes: 10,
      recorded: { OFFLINE: 7, NONE: 3 },
      converted: 7,
      rate_pct: 70,
    },
  ],
  unmet_demand: [
    {
      sku: 'DBC-VCSERUM-50',
      label: 'Vitamin C Glow Serum 50 ml',
      area: 'andheri',
      weekday: 'saturday',
      count: 4,
      reasons: { OUT_OF_STOCK: 4 },
    },
  ],
  weekday: {
    days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((weekday) => ({
      weekday,
      lookups: weekday === 'saturday' ? 12 : 5,
      no_store: weekday === 'saturday' ? 5 : 0,
      no_store_pct: weekday === 'saturday' ? 42 : 0,
      reservations: 2,
      completions: 1,
    })),
    reading: {
      kind: 'AVAILABILITY_PROBLEM',
      text: "Saturday lookups for Vitamin C Glow Serum 30 ml were 2.4× the other days' average, but 42% found no store with stock (other days: 0%). This looks like an availability problem, not a demand problem.",
    },
  },
  fill_rate: [],
  suggestions: [
    {
      rule: 'STOCK_UNMET_AREA',
      text: 'Vitamin C Glow Serum 50 ml was requested 4 times in Andheri in the last 7 days with no store in stock. Suggested: ask North Retail to stock Andheri Store.',
      evidence: { kind: 'EVENTS', ids: ['evt_1', 'evt_2', 'evt_3', 'evt_4'] },
    },
  ],
};

describe('Brand Console — Outcomes & insights (M6)', () => {
  it('shows the funnel, the deterministic weekday reading, suggestions with their evidence, and the history label + toggle', async () => {
    const api = client((p) => {
      if (p === '/api/me') return BRAND;
      if (p.startsWith('/api/brand/insights'))
        return p.includes('include_history=false')
          ? { ...INSIGHTS, demo_history: { included: false, records: 0 } }
          : INSIGHTS;
      throw new Error(p);
    });
    render_('/brand/outcomes', api); // the old link redirects to /brand/insights
    expect(await screen.findByText(/Saturday lookups for Vitamin C Glow Serum 30 ml were 2.4×/)).toBeInTheDocument();
    expect(screen.getByText(/Includes synthetic demo history \(412 generated records\)/)).toBeInTheDocument();
    // The funnel is a chart with the step conversion, and a table on request.
    expect(screen.getByRole('img', { name: /Journey funnel: Storefront intents 40/ })).toBeInTheDocument();
    expect(screen.getByText('→ 58%')).toBeInTheDocument(); // holds 12 → pickups 7
    fireEvent.click(screen.getAllByRole('button', { name: 'Show as table' })[0]!);
    const funnel = screen.getByRole('table', { name: 'Journey funnel' });
    expect(within(funnel).getByText('Pickups').closest('tr')).toHaveTextContent('7');
    expect(screen.getByText(/ask North Retail to stock Andheri Store/)).toBeInTheDocument();
    expect(screen.getByText('Based on 4 store lookups')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Conversion by action' })).toHaveTextContent('7 (70%)');
    fireEvent.click(screen.getByLabelText('Include synthetic demo history'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/brand/insights?days=7&include_history=false'));
    fireEvent.click(screen.getByRole('button', { name: 'Last 28 days' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/brand/insights?days=28&include_history=false'));
  });
});

describe('storefront snippet — qs_ref (M6)', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    sessionStorage.clear();
  });

  it('keeps a valid qs_ref from the landing URL for the session and ignores malformed ones', () => {
    delete window.QwikspotIntent;
    window.history.replaceState(null, '', '/demo-store?qs_ref=0123456789ABCDEFGHJKMNPQRS#product=prd_1001');
    // eslint-disable-next-line no-new-func
    new Function(SNIPPET)();
    const tracker = window.QwikspotIntent!.init({ apiBaseUrl: '', brandId: 'brd_demo', openLink: () => {} });
    expect(tracker.attributionRef!()).toBe('0123456789ABCDEFGHJKMNPQRS');
    window.history.replaceState(null, '', '/demo-store?qs_ref=<script>');
    tracker.init({ apiBaseUrl: '', brandId: 'brd_demo', openLink: () => {} });
    expect(tracker.attributionRef!()).toBe('0123456789ABCDEFGHJKMNPQRS');
  });
});
