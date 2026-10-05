import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import type { QueueReservation } from '../pages/retailer/RetailerQueue';
import type { StoreInsights } from '../pages/retailer/StoreDemand';

/** UI-4: the Store Console (Change 16; audit Retailer findings). */

const RETAIL: MeResponse = {
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
    address: 'Lokhandwala Complex',
    store_status: 'ACTIVE',
    store_hours: { timezone: 'Asia/Kolkata', monday: '10:00-21:00' },
  },
};
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const hold = (over: Partial<QueueReservation> = {}): QueueReservation => ({
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
  created_at: inMin(-5),
  expires_at: inMin(18),
  cancelled_by: null,
  cancel_reason: null,
  last_notification: null,
  why_here: {
    text: 'Powai Store was closer but out of stock. You were the nearest store with stock — 7.6 km from the customer.',
    distance_km: 7.6,
    closer_unavailable: [{ store_name: 'Powai Store', reason: 'OUT_OF_STOCK' }],
    options: 1,
  },
  image_url: '/demo-products/vitamin-c-glow-serum.png',
  demo_history: false,
  ...over,
});

const SUMMARY = {
  days: 7,
  reservations: 9,
  completed: 7,
  refused: 1,
  expired: 1,
  completion_pct: 78,
  value: { amount: 5565, currency: 'INR' },
  synthetic: 6,
};

function storeApi(routes: (path: string) => unknown): ApiClient {
  return {
    get: vi.fn(async (p: string) => {
      if (p === '/api/me') return RETAIL;
      const hit = routes(p);
      if (hit !== undefined) return hit;
      throw new Error(`unexpected GET ${p}`);
    }) as ApiClient['get'],
    post: vi.fn() as ApiClient['post'],
    patch: vi.fn(async () => ({})) as ApiClient['patch'],
    upload: vi.fn() as ApiClient['upload'],
  };
}

function renderAt(path: string, api: ApiClient) {
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

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.title = '';
});

describe('Today', () => {
  it('the value strip shows the last 7 days with completion, value (est.) and the synthetic marker', async () => {
    renderAt(
      '/store',
      storeApi((p) =>
        p.startsWith('/api/reservations') ? { reservations: [] } : p.endsWith('/summary') ? SUMMARY : undefined,
      ),
    );
    const strip = await screen.findByRole('region', { name: 'Last 7 days' });
    expect(within(strip).getByText('78%')).toBeInTheDocument();
    expect(within(strip).getByText('₹5,565')).toBeInTheDocument();
    expect(within(strip).getByText('est.')).toBeInTheDocument();
    expect(within(strip).getAllByText('Includes synthetic history')).toHaveLength(6);
    expect(screen.getByText('6 of these 9 holds are synthetic demo history.')).toBeInTheDocument();
    expect(
      screen.getByText("Nothing waiting. New holds from Demo Beauty Co's WhatsApp appear here."),
    ).toBeInTheDocument();
  });

  it('"Next up" is the most urgent hold with one big action; every card says why the hold came', async () => {
    const rows = [
      hold(),
      hold({
        reservation_id: 'res_2',
        status: 'CONFIRMED',
        allowed_actions: ['READY', 'CANCELLED'],
        expires_at: inMin(40),
        why_here: null,
      }),
    ];
    renderAt(
      '/store',
      storeApi((p) =>
        p.startsWith('/api/reservations') ? { reservations: rows } : p.endsWith('/summary') ? SUMMARY : undefined,
      ),
    );
    const next = await screen.findByRole('region', { name: 'Next up' });
    const card = within(next).getByRole('article');
    expect(within(card).getByRole('button', { name: 'Confirm' })).toHaveClass('next-up__action');
    expect(within(card).getByText(/Powai Store was closer but out of stock/)).toBeInTheDocument();
    expect(within(card).getByText(/Customer •••• 4821/)).toBeInTheDocument();
    expect(screen.getByText('Also waiting (1)')).toBeInTheDocument();
    // No trace: a plain fallback that names the brand, never a customer.
    expect(screen.getByText(/A customer of Demo Beauty Co reserved this through WhatsApp\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/latitude|longitude|sim:/);
  });

  it('Complete shows the code hint', async () => {
    renderAt(
      '/store',
      storeApi((p) =>
        p.startsWith('/api/reservations')
          ? { reservations: [hold({ status: 'CUSTOMER_ARRIVED', allowed_actions: ['COMPLETED', 'CANCELLED'] })] }
          : p.endsWith('/summary')
            ? SUMMARY
            : undefined,
      ),
    );
    expect(await screen.findByText('Ask for the 6-digit code in their WhatsApp.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete' })).toBeDisabled();
  });
});

describe('new-hold alert', () => {
  it('a new hold raises a toast, a New badge, the nav count and the tab title — no sound by default', async () => {
    const audio = vi.fn();
    vi.stubGlobal('AudioContext', audio);
    let rows: QueueReservation[] = [];
    renderAt(
      '/store',
      storeApi((p) =>
        p.startsWith('/api/reservations') ? { reservations: rows } : p.endsWith('/summary') ? SUMMARY : undefined,
      ),
    );
    await screen.findByText(/Nothing waiting/);
    expect(screen.queryByText(/New hold:/)).not.toBeInTheDocument(); // nothing on the first load

    rows = [hold()];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('New hold: 1 × Vitamin C Glow Serum 30 ml — confirm it')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('(1) New hold · Store Console'));
    expect(await screen.findByLabelText('1 new holds to confirm')).toHaveTextContent('1');
    expect(audio).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Sound for new holds')).not.toBeChecked();
  });

  it('with sound switched on (remembered per browser), a new hold plays one tone', async () => {
    const start = vi.fn();
    const ctx = {
      currentTime: 0,
      destination: {},
      createOscillator: () => ({
        frequency: { value: 0 },
        connect: (g: unknown) => g,
        start,
        stop: vi.fn(),
        onended: null,
      }),
      createGain: () => ({
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: () => ({}),
      }),
      close: vi.fn(),
    };
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function AudioContext() {
        return ctx;
      }),
    );
    let rows: QueueReservation[] = [];
    renderAt(
      '/store',
      storeApi((p) =>
        p.startsWith('/api/reservations') ? { reservations: rows } : p.endsWith('/summary') ? SUMMARY : undefined,
      ),
    );
    fireEvent.click(await screen.findByLabelText('Sound for new holds'));
    expect(window.localStorage.getItem('qs_store_sound')).toBe('on');
    rows = [hold()];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText(/New hold:/);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('History', () => {
  it('shows how each hold ended, with filters', async () => {
    const rows = [
      hold({ reservation_id: 'a', status: 'COMPLETED', allowed_actions: [] }),
      hold({
        reservation_id: 'b',
        status: 'CANCELLED',
        cancelled_by: 'RETAILER',
        cancel_reason: 'DAMAGED',
        allowed_actions: [],
        demo_history: true,
      }),
      hold({ reservation_id: 'c', status: 'EXPIRED', allowed_actions: [] }),
    ];
    renderAt(
      '/store/history',
      storeApi((p) => (p.startsWith('/api/reservations') ? { reservations: rows } : undefined)),
    );
    expect(await screen.findByText('Picked up — in-store purchase')).toBeInTheDocument();
    expect(screen.getByText('Refused: Damaged')).toBeInTheDocument();
    expect(screen.getByText('Expired — not collected')).toBeInTheDocument();
    expect(screen.getByText('Synthetic')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refused' }));
    expect(screen.queryByText('Picked up — in-store purchase')).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });
});

const INSIGHTS: StoreInsights = {
  store_id: 'st_north_2',
  period: { days: 7, from: '', to: '', timezone: 'Asia/Kolkata' },
  demo_history: { included: true },
  missed: [
    {
      sku: 'DBC-VCSERUM-30',
      label: 'Vitamin C Glow Serum 30 ml',
      weekday: 'saturday',
      reason: 'OUT_OF_STOCK',
      count: 8,
    },
  ],
  fill_rate: [
    { weekday: 'saturday', nearest: 8, had_stock: 0, fill_pct: 0, refusals: {} },
    { weekday: 'monday', nearest: 5, had_stock: 4, fill_pct: 80, refusals: {} },
  ],
  refusals: { NOT_ACTUALLY_IN_STOCK: 0, DAMAGED: 1, STORE_CLOSING_EARLY: 0, OTHER: 0 },
  suggestions: [
    {
      rule: 'RAISE_STOCK_BEFORE_PEAK',
      text: 'Andheri Store was the nearest store but out of stock of Vitamin C Glow Serum 30 ml 8 times on Saturdays in the last 7 days. Suggested: raise its Vitamin C Glow Serum 30 ml stock before Saturday.',
    },
  ],
};

describe('Demand near you', () => {
  it('shows missed demand, the weekday chart with the problem day, refusals and the brand’s suggestions', async () => {
    const api = storeApi((p) => (p.startsWith('/api/retail/stores/st_north_2/insights') ? INSIGHTS : undefined));
    renderAt('/store/demand', api);
    const missed = await screen.findByRole('table', { name: 'Missed demand' });
    expect(within(missed).getByText('Saturday').closest('tr')).toHaveTextContent('8');
    expect(within(missed).getByText('out of stock')).toBeInTheDocument();
    expect(screen.getByText('problem day')).toBeInTheDocument();
    expect(screen.getByText(/Holds you refused: Damaged 1/)).toBeInTheDocument();
    expect(screen.getByText(/raise its Vitamin C Glow Serum 30 ml stock before Saturday/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/retail/stores/st_north_2/insights?days=7&include_history=true');
  });

  it('with no data yet, says so plainly', async () => {
    renderAt(
      '/store/demand',
      storeApi((p) =>
        p.startsWith('/api/retail/stores/st_north_2/insights')
          ? { ...INSIGHTS, missed: [], fill_rate: [], refusals: {}, suggestions: [] }
          : undefined,
      ),
    );
    expect(
      await screen.findByText(
        'Nothing to show yet. Demand appears here as shoppers ask Demo Beauty Co for products near your store.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Missed demand' })).not.toBeInTheDocument();
  });
});

describe('Store navigation', () => {
  it('Today · History · Stock · Demand', async () => {
    renderAt(
      '/store',
      storeApi((p) =>
        p.startsWith('/api/reservations') ? { reservations: [] } : p.endsWith('/summary') ? SUMMARY : undefined,
      ),
    );
    const nav = await screen.findByRole('navigation', { name: 'Store Console' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Today', 'History', 'Stock', 'Demand']);
  });
});
