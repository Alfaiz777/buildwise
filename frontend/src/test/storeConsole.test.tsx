import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import { hoursText } from '../pages/retailer/RetailerHome';
import { dayLabel, holdCountdown, type QueueReservation } from '../pages/retailer/RetailerQueue';
import type { StoreInsights } from '../pages/retailer/StoreDemand';

/** UI-4: the Store Console (Change 16; audit Retailer findings). */

const RETAIL: MeResponse = {
  scope: 'RETAIL',
  role: 'RETAIL_ADMIN',
  user: { user_id: 'r', email: 'healthplus@demo.test' },
  brand_id: 'brd_demo',
  brand_name: 'Demo Beauty Co',
  retailer_id: 'rtl_north',
  retailer_name: 'Ahmedabad Retail Partners',
  store_id: 'st_north_2',
  store: {
    store_id: 'st_north_2',
    store_name: 'HealthPlus Chemist',
    city: 'Ahmedabad',
    address: 'Lokhandwala Complex',
    store_status: 'ACTIVE',
    store_hours: { timezone: 'Asia/Kolkata', monday: '10:00-21:00' },
  },
};
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const hold = (over: Partial<QueueReservation> = {}): QueueReservation => ({
  reservation_id: 'res_1',
  store_name: 'HealthPlus Chemist',
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
    text: 'Skin Studio was closer but out of stock. You were the nearest store with stock — 7.6 km from the customer.',
    distance_km: 7.6,
    closer_unavailable: [{ store_name: 'Skin Studio', reason: 'OUT_OF_STOCK' }],
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
    // UI-P2: one page-level demo badge (its tooltip says how many), not one per tile.
    expect(within(strip).getByText('Includes demo history · 6 of 9 holds')).toBeInTheDocument();
    expect(screen.getByText('6 of these 9 holds are synthetic demo history.')).toBeInTheDocument();
    expect(within(strip).getByText('Holds → Picked up').parentElement).toHaveTextContent('9 → 7');
    expect(within(strip).getByText('Refused').parentElement).toHaveTextContent('1');
    expect(within(strip).getByText('Expired').parentElement).toHaveTextContent('1');
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
    expect(within(card).getByText(/Skin Studio was closer but out of stock/)).toBeInTheDocument();
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
    await screen.findByText("You're all caught up.");
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
    // UI-P2: grouped by day, one row per hold with a coloured outcome pill.
    const today = await screen.findByRole('region', { name: 'Today' });
    expect(within(today).getByText('Picked up')).toHaveClass('ui-pill--success');
    expect(within(today).getByText('Refused · Damaged')).toHaveClass('ui-pill--danger');
    expect(within(today).getByText('Expired')).toHaveClass('ui-pill--neutral');
    expect(within(today).getAllByText('Demo')).toHaveLength(1);
    // The words for how it ended and why it came are in the expandable row.
    expect(screen.getByText('Picked up — in-store purchase.')).toBeInTheDocument();
    expect(screen.getByText('Refused: Damaged.')).toBeInTheDocument();
    expect(screen.getByText('Expired — not collected.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refused' }));
    expect(screen.queryByText('Picked up — in-store purchase.')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Today' })).getAllByRole('listitem')).toHaveLength(1);
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
      text: 'HealthPlus Chemist was the nearest store but out of stock of Vitamin C Glow Serum 30 ml 8 times on Saturdays in the last 7 days. Suggested: raise its Vitamin C Glow Serum 30 ml stock before Saturday.',
    },
  ],
};

describe('Demand near you', () => {
  it('shows missed demand, the weekday chart with the problem day, refusals and the brand’s suggestions', async () => {
    const api = storeApi((p) => (p.startsWith('/api/retail/stores/st_north_2/insights') ? INSIGHTS : undefined));
    renderAt('/store/demand', api);
    const missed = await screen.findByRole('list', { name: 'Missed demand' });
    const row = within(missed).getByText('Vitamin C Glow Serum 30 ml').closest('li')!;
    expect(row).toHaveTextContent('Saturday · out of stock');
    expect(row).toHaveTextContent('8 times');
    expect(within(row).getByRole('button', { name: /Ask Qwikspot why/ })).toBeInTheDocument();
    expect(screen.getByText('problem day')).toBeInTheDocument();
    const refused = screen.getByRole('list', { name: 'Holds you refused' });
    expect(within(refused).getByText('Damaged').closest('li')).toHaveTextContent('Damaged1');
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
    expect(screen.queryByRole('list', { name: 'Missed demand' })).not.toBeInTheDocument();
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

describe('UI-P2 — Today', () => {
  it('the holds hero comes first: "Next up" with the countdown, Refuse in the menu, a live indicator', async () => {
    renderAt(
      '/store',
      storeApi((p) =>
        p.startsWith('/api/reservations') ? { reservations: [hold()] } : p.endsWith('/summary') ? SUMMARY : undefined,
      ),
    );
    const next = await screen.findByRole('region', { name: 'Next up' });
    const card = within(next).getByRole('article', { name: '1 × Vitamin C Glow Serum 30 ml' });
    expect(within(card).getByText(/Held for (17|18) more min/)).toBeInTheDocument();
    expect(within(card).getByText(/Why this came to you:/)).toBeInTheDocument();
    // The hero is above the AI brief and the 7-day strip.
    const strip = await screen.findByRole('region', { name: 'Last 7 days' });
    expect(next.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Refuse is not a button on the card; it is in "⋯".
    expect(within(card).queryByRole('button', { name: 'Refuse' })).not.toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: 'More actions for 1 × Vitamin C Glow Serum 30 ml' }),
    ).toBeInTheDocument();
    // The live indicator and the sound switch sit in the section header.
    expect(screen.getByRole('status')).toHaveTextContent(/pdated/);
    expect(screen.getByRole('switch', { name: 'Sound for new holds' })).not.toBeChecked();
  });

  it('refusing needs a reason in the dialog, then sends it', async () => {
    const api = storeApi((p) =>
      p.startsWith('/api/reservations') ? { reservations: [hold()] } : p.endsWith('/summary') ? SUMMARY : undefined,
    );
    renderAt('/store', api);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for 1 × Vitamin C Glow Serum 30 ml' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refuse…' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Refuse hold' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Refusal reason/), { target: { value: 'DAMAGED' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/api/reservations/res_1',
        expect.objectContaining({ status: 'CANCELLED', cancel_reason: 'DAMAGED', expected_current_status: 'PENDING' }),
      ),
    );
  });

  it('when nothing is waiting: all caught up, with the time of the last hold', async () => {
    renderAt(
      '/store',
      storeApi((p) =>
        p === '/api/reservations?view=history'
          ? { reservations: [hold({ status: 'COMPLETED', allowed_actions: [], created_at: inMin(-90) })] }
          : p.startsWith('/api/reservations')
            ? { reservations: [] }
            : p.endsWith('/summary')
              ? SUMMARY
              : undefined,
      ),
    );
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
    expect(await screen.findByText(/^Last hold: \d\d:\d\d, /)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Next up' })).not.toBeInTheDocument();
  });

  it('the countdown turns amber under 10 minutes and red once expired', () => {
    const now = Date.now();
    expect(holdCountdown(new Date(now + 18 * 60_000).toISOString(), now)).toEqual({
      text: 'Held for 18 more min',
      tone: 'neutral',
    });
    expect(holdCountdown(new Date(now + 6 * 60_000).toISOString(), now).tone).toBe('warning');
    expect(holdCountdown(new Date(now - 60_000).toISOString(), now)).toEqual({ text: 'Hold expired', tone: 'danger' });
  });
});

describe('UI-P2 — History, Stock, hours', () => {
  it('days read Today / Yesterday / "Mon 12 Oct" in store time', () => {
    const now = Date.parse('2026-10-17T12:00:00+05:30');
    expect(dayLabel('2026-10-17T09:00:00+05:30', 'Asia/Kolkata', now)).toBe('Today');
    expect(dayLabel('2026-10-16T09:00:00+05:30', 'Asia/Kolkata', now)).toBe('Yesterday');
    expect(dayLabel('2026-10-12T09:00:00+05:30', 'Asia/Kolkata', now)).toBe('Mon 12 Oct');
  });

  it('the why is in the expandable history row', async () => {
    renderAt(
      '/store/history',
      storeApi((p) =>
        p.startsWith('/api/reservations')
          ? { reservations: [hold({ status: 'COMPLETED', allowed_actions: [] })] }
          : undefined,
      ),
    );
    const row = (await screen.findByText('Picked up', { selector: '.ui-pill' })).closest('details')!;
    expect(row).not.toHaveAttribute('open');
    fireEvent.click(within(row).getByText('1 × Vitamin C Glow Serum 30 ml'));
    expect(row).toHaveAttribute('open');
    expect(within(row).getByText(/Skin Studio was closer but out of stock/)).toBeInTheDocument();
  });

  it('stock: low and out of stock first, chips filter, search narrows', async () => {
    const at = new Date().toISOString();
    const item = (sku: string, title: string, quantity: number, available: number, status: string) => ({
      sku,
      product_title: title,
      variant_title: null,
      quantity,
      reserved_quantity: quantity - available,
      available_quantity: available,
      availability_status: status,
      last_updated_at: at,
    });
    renderAt(
      '/store/stock',
      storeApi((p) =>
        p.endsWith('/inventory')
          ? {
              items: [
                item('A-1', 'Aloe Gel', 9, 9, 'IN_STOCK'),
                item('B-1', 'Body Lotion', 3, 2, 'LOW_STOCK'),
                item('C-1', 'Clay Mask', 1, 0, 'OUT_OF_STOCK'),
              ],
            }
          : undefined,
      ),
    );
    await screen.findByText('A-1');
    const skus = () => screen.getAllByText(/^[ABC]-1$/).map((e) => e.textContent);
    expect(skus()).toEqual(['C-1', 'B-1', 'A-1']);
    expect(screen.getByText('0', { selector: '.st-avail' })).toHaveClass('st-avail--danger');
    expect(screen.getByText('2', { selector: '.st-avail' })).toHaveClass('st-avail--warning');
    const chips = screen.getByRole('group', { name: 'Filter by stock' });
    fireEvent.click(within(chips).getByRole('button', { name: '1 Low stock' }));
    expect(skus()).toEqual(['B-1']);
    fireEvent.click(within(chips).getByRole('button', { name: '1 Low stock' }));
    fireEvent.change(screen.getByLabelText('Search stock'), { target: { value: 'aloe' } });
    expect(skus()).toEqual(['A-1']);
    expect(
      screen.getByText(/Updated .* from Demo Beauty Co's retail file · You can't edit stock here/),
    ).toBeInTheDocument();
  });

  it('store hours in plain words', () => {
    const all = Object.fromEntries(
      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, '00:00-23:59']),
    );
    expect(hoursText({ timezone: 'Asia/Kolkata', ...all })).toBe('Open 24 hours, every day');
    const week = Object.fromEntries(
      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d) => [d, '10:00-21:00']),
    );
    expect(hoursText({ timezone: 'Asia/Kolkata', ...week })).toBe('Mon–Sat 10:00–21:00 · Sun closed');
    expect(hoursText(null)).toBeNull();
  });
});

describe('UI-P2 — Demand', () => {
  it('the ring, the busiest day, the chart tooltip and the table fallback', async () => {
    renderAt(
      '/store/demand',
      storeApi((p) => (p.startsWith('/api/retail/stores/st_north_2/insights') ? INSIGHTS : undefined)),
    );
    const summary = await screen.findByRole('region', { name: 'Demand summary' });
    expect(within(summary).getByText('31%')).toBeInTheDocument();
    expect(within(summary).getByText('You had stock 4 of 13 times')).toBeInTheDocument();
    expect(within(summary).getByText('Missed shoppers').parentElement).toHaveTextContent('8');
    expect(within(summary).getByText('Busiest day').parentElement).toHaveTextContent('Sat');
    expect(screen.getByText('Busiest')).toBeInTheDocument();
    // Focus a day: its numbers in a tooltip.
    fireEvent.focus(screen.getByLabelText('Sat · nearest 8 times · had it 0 · missed 8'));
    expect(document.querySelector('.chart__tooltip')).toHaveTextContent('Sat · nearest 8 times · had it 0 · missed 8');
    fireEvent.click(screen.getByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('table', { name: 'Demand vs availability by weekday' });
    expect(within(table).getByText('Saturday').closest('tr')).toHaveTextContent('8 (100%)');
  });

  it('positive empty states when nothing was missed, refused or suggested', async () => {
    renderAt(
      '/store/demand',
      storeApi((p) =>
        p.startsWith('/api/retail/stores/st_north_2/insights')
          ? {
              ...INSIGHTS,
              missed: [],
              refusals: { DAMAGED: 0 },
              suggestions: [],
              fill_rate: [{ weekday: 'saturday', nearest: 5, had_stock: 5, fill_pct: 100, refusals: {} }],
            }
          : undefined,
      ),
    );
    expect(await screen.findByText('You had what shoppers asked for in this period.')).toBeInTheDocument();
    expect(screen.getByText("You didn't refuse any hold in this period.")).toBeInTheDocument();
    expect(
      screen.getByText(
        'No suggestions from Demo Beauty Co this period. They appear here when the brand sees something for your store.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('You had stock 5 of 5 times')).toBeInTheDocument();
  });
});
