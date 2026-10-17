import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import type {
  ConversationDetail,
  ConversationRow,
  Recommendation,
  ReservationRow,
} from '../pages/brand/conversationTypes';
import { stepPct } from '../pages/brand/InsightCharts';
import { buildJourney } from '../pages/brand/journey';
import { attentionItems, kpis } from '../pages/brand/overview';
import { whySentence } from '../pages/brand/whySentence';
import { INSIGHTS, SETTINGS } from './brandFixtures';

/** UI-3: the results-first Brand Console (Change 16; audit Parts 6–10). */

const BRAND: MeResponse = {
  scope: 'BRAND',
  role: 'BRAND_ADMIN',
  user: { user_id: 'a', email: 'admin@demo-brand.test' },
  brand_id: 'brd_demo',
  brand_name: 'Demo Beauty Co',
};
const NOW = Date.parse('2026-10-05T10:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const row = (over: Partial<ConversationRow>): ConversationRow => ({
  conversation_id: 'conv_1',
  customer_ref: 'sim:judge_ab12',
  channel: 'SIMULATOR',
  status: 'OPEN',
  human_handoff: false,
  handoff_at: null,
  last_message_at: ago(1),
  last_inbound_at: ago(1),
  intent: null,
  ...over,
});
const reservation = (over: Partial<ReservationRow>): ReservationRow => ({
  reservation_id: 'res_1',
  store_id: 'st_north_2',
  store_name: 'HealthPlus Chemist',
  product_title: 'Vitamin C Glow Serum',
  variant_title: '30 ml',
  sku: 'DBC-VCSERUM-30',
  quantity: 1,
  status: 'PENDING',
  active: true,
  customer_display: 'Customer •••• 4821',
  created_at: ago(30),
  expires_at: ago(-10),
  ...over,
});

function apiWith(routes: Record<string, unknown>): ApiClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path === '/api/me') return BRAND;
      const hit = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((k) => path === k || path.startsWith(`${k}?`));
      if (hit) return routes[hit];
      throw new Error(`unexpected GET ${path}`);
    }) as ApiClient['get'],
    post: vi.fn(async () => ({})) as ApiClient['post'],
    patch: vi.fn() as ApiClient['patch'],
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
  window.localStorage.clear();
});

describe('Overview — KPI tiles and attention', () => {
  it('kpis(): every tile is an insights field; conversion = purchases ÷ conversations; value says est.', () => {
    const tiles = Object.fromEntries(kpis(INSIGHTS).map((k) => [k.key, k]));
    expect(tiles.intents!.value).toBe('40');
    expect(tiles.conversations!.value).toBe('20');
    expect(tiles.holds!.value).toBe('12');
    expect(tiles.pickups!.value).toBe('7');
    expect(tiles.online!.value).toBe('3'); // ONLINE 2 + ALTERNATIVE 1
    expect(tiles.conversion!.value).toBe('67%'); // purchases (7 + 2 + 1) ÷ finished journeys (10 + 5 NONE)
    expect(tiles.conversion!.sub).toBe('10 of 15 finished journeys bought');
    expect(tiles.value).toMatchObject({ value: '₹7,950', estimated: true });
    const none = kpis({
      ...INSIGHTS,
      funnel: { ...INSIGHTS.funnel, outcomes: { OFFLINE: 0, ONLINE: 0, ALTERNATIVE: 0, NONE: 0 }, value: undefined },
    });
    expect(none.find((k) => k.key === 'conversion')!.value).toBe('—');
    expect(none.find((k) => k.key === 'value')).toBeUndefined(); // no value field → no invented tile
  });

  it('the Overview shows the tiles with the synthetic marker, the reading and the top suggestion linked to its store', async () => {
    renderAt(
      '/brand',
      apiWith({
        '/api/brand/insights': INSIGHTS,
        '/api/brand/conversations': { conversations: [row({ human_handoff: true, handoff_at: ago(14) })] },
        '/api/reservations': { reservations: [] },
        '/api/brand/stores': {
          stores: [
            { store_id: 'st_north_2', store_name: 'HealthPlus Chemist', sku_count: 10, stock_updated_at: ago(5) },
          ],
        },
        '/api/products': {
          products: [],
          retail_mappings_needing_attention: [],
          mapping_summary: { auto_matched: 1, needs_attention: 0 },
        },
        '/api/brand/settings': SETTINGS,
        '/api/brand/connections': { connections: [] },
        '/api/brand/demo': { reset_available: false },
      }),
    );
    const results = await screen.findByRole('region', { name: 'Results' });
    expect(within(results).getByText('Intents caught')).toBeInTheDocument();
    expect(within(results).getByText('67%')).toBeInTheDocument();
    // UI-P3: one page-level demo badge (its tooltip has the count), no per-tile markers.
    expect(screen.getAllByText('Includes demo history')).toHaveLength(1);
    expect(within(results).queryByText('Includes synthetic history')).not.toBeInTheDocument();
    expect(
      screen.getByText(/These numbers include synthetic demo history \(120 generated records\)/),
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /1 customer is waiting for a person/ })).toHaveAttribute(
      'href',
      '/brand/conversations?filter=handoff',
    );
    expect(screen.getByRole('link', { name: /1 customer is waiting for a person/ })).toHaveTextContent(
      'Open 1 handoff →',
    );
    expect(screen.getByText(/2.7× the other days' average/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open HealthPlus Chemist →' })[0]).toHaveAttribute(
      'href',
      '/brand/network#store-st_north_2',
    );
    // The nav counts the conversation waiting for a person.
    expect(await screen.findByLabelText('1 waiting for a person')).toHaveTextContent('1');
  });

  it('attentionItems(): handoff minutes, refusals in the last 24 h only, stale stock, mapping issues', () => {
    const items = attentionItems({
      conversations: [
        row({ human_handoff: true, handoff_at: ago(14) }),
        row({ human_handoff: true, handoff_at: ago(3) }),
      ],
      reservations: [
        reservation({
          status: 'CANCELLED',
          cancelled_by: 'RETAILER',
          cancel_reason: 'NOT_ACTUALLY_IN_STOCK',
          cancelled_at: ago(60),
        }),
        reservation({
          reservation_id: 'old',
          status: 'CANCELLED',
          cancelled_by: 'RETAILER',
          cancelled_at: ago(26 * 60),
        }),
        reservation({ reservation_id: 'cust', status: 'CANCELLED', cancelled_by: 'CUSTOMER', cancelled_at: ago(5) }),
      ],
      stores: [
        {
          store_id: 'st_3',
          store_name: 'Skin Studio',
          city: 'Ahmedabad',
          store_status: 'ACTIVE',
          retailer_id: 'r',
          retail_admin_user_id: null,
          sku_count: 7,
          stock_updated_at: ago(3 * 24 * 60),
        },
        {
          store_id: 'st_2',
          store_name: 'HealthPlus Chemist',
          city: 'Ahmedabad',
          store_status: 'ACTIVE',
          retailer_id: 'r',
          retail_admin_user_id: null,
          sku_count: 9,
          stock_updated_at: ago(30),
        },
      ],
      freshnessHours: 24,
      mappingIssues: 3,
      now: NOW,
    });
    expect(items.map((i) => i.text)).toEqual([
      '2 customers are waiting for a person — longest 14 min',
      'HealthPlus Chemist refused 1 hold in the last 24 h — not actually in stock',
      'Skin Studio stock is 3 days old — ask for a fresh retail file',
      '3 retail SKUs need attention — their stock is not used yet',
    ]);
    expect(
      attentionItems({
        conversations: [],
        reservations: [],
        stores: [],
        freshnessHours: 24,
        mappingIssues: 0,
        now: NOW,
      }),
    ).toEqual([]);
  });
});

const discovery: Recommendation = {
  recommendation_id: 'rec_1',
  action: 'STORE_DISCOVERY',
  runtime: 'MOCK',
  decision_source: 'AGENT',
  guardrail_status: 'ALLOWED',
  rationale_summary: 'Nearest eligible store is HealthPlus Chemist.',
  target_store_id: 'st_north_2',
  target_variant_id: 'v30',
  proposed_at: ago(20),
  reservation: null,
  trace: {
    context_hash: 'x',
    context_summary: {},
    tool_calls: [],
    eligible: [{ store_id: 'st_north_2', store_name: 'HealthPlus Chemist', distance_km: 7.62, variant_id: 'v30' }],
    excluded: [
      { store_id: 'st_north_1', store_name: 'Wellness Mart', reason: 'TOO_FAR', distance_km: 10.6, variant_id: 'v30' },
      {
        store_id: 'st_north_3',
        store_name: 'Skin Studio',
        reason: 'OUT_OF_STOCK',
        distance_km: 0.68,
        variant_id: 'v30',
      },
    ],
    guardrail: { status: 'ALLOWED', reason_code: null, checked: 'OFFERED_STORES' },
    executed_action: null,
    repaired: false,
    fallback_reason: null,
  },
};

describe('"Why Qwikspot did this" sentences', () => {
  it('store offered: nearest excluded stores first, distances rounded', () => {
    expect(whySentence(discovery)).toBe(
      'Offered HealthPlus Chemist (7.6 km) because Skin Studio (0.7 km) is out of stock and Wellness Mart (10.6 km) is too far.',
    );
  });

  it('a farther excluded store is never the reason: the offered store was simply the nearest with stock', () => {
    const nearest: Recommendation = {
      ...discovery,
      target_store_id: 'st_north_1',
      trace: {
        ...discovery.trace!,
        eligible: [
          { store_id: 'st_north_1', store_name: 'Wellness Mart', distance_km: 0.7, variant_id: 'v30' },
          { store_id: 'st_north_2', store_name: 'HealthPlus Chemist', distance_km: 8.5, variant_id: 'v30' },
        ],
        excluded: [
          {
            store_id: 'st_north_3',
            store_name: 'Skin Studio',
            reason: 'TOO_FAR',
            distance_km: 10.2,
            variant_id: 'v30',
          },
        ],
      },
    };
    expect(whySentence(nearest)).toBe('Offered Wellness Mart (0.7 km), the nearest store with stock.');
  });

  it('no store qualified: says why, and that buying online was offered', () => {
    const r: Recommendation = {
      ...discovery,
      action: 'ONLINE_PURCHASE',
      target_store_id: null,
      trace: {
        ...discovery.trace!,
        eligible: [],
        excluded: [
          {
            store_id: 'st_north_3',
            store_name: 'Skin Studio',
            reason: 'OUT_OF_STOCK',
            distance_km: 0.68,
            variant_id: 'v30',
          },
          {
            store_id: 'st_north_2',
            store_name: 'HealthPlus Chemist',
            reason: 'CLOSED',
            distance_km: 7.62,
            variant_id: 'v30',
          },
        ],
      },
    };
    expect(whySentence(r)).toBe(
      'No store could take this today: Skin Studio (0.7 km) is out of stock and HealthPlus Chemist (7.6 km) is closed now. Offered to buy online instead.',
    );
  });

  it('guardrail blocked: the safety check in plain words; a fallback says so', () => {
    const blocked: Recommendation = {
      ...discovery,
      action: 'STORE_RESERVATION',
      guardrail_status: 'BLOCKED',
      trace: {
        ...discovery.trace!,
        guardrail: { status: 'BLOCKED', reason_code: 'OUT_OF_STOCK', checked: 'CREATE_RESERVATION' },
      },
    };
    expect(whySentence(blocked)).toBe(
      "Didn't hold at HealthPlus Chemist: the stock check just before holding found none left.",
    );
    const fallback: Recommendation = {
      ...discovery,
      action: 'NO_ACTION',
      decision_source: 'DETERMINISTIC_FALLBACK',
      trace: { ...discovery.trace!, eligible: [], excluded: [], fallback_reason: 'TIMEOUT' },
    };
    expect(whySentence(fallback)).toBe(
      "Asked the customer what they need. (The assistant couldn't decide, so a safe fixed reply was sent.)",
    );
  });
});

const DETAIL: ConversationDetail = {
  ...row({ handoff_at: null }),
  brand_display_name: 'Demo Beauty Co',
  intent: {
    intent_id: 'int_1',
    who: 'sim:judge_ab12',
    anonymous: false,
    intent_stage: 'PRODUCT_VIEW',
    intent_strength: 'HIGH_INTENT',
    intent_type: 'STORE_ORIENTED',
    status: 'ACTIVE',
    product_title: 'Vitamin C Glow Serum',
    variant_title: '30 ml',
    matched_category: null,
    last_event: 'WHATSAPP_CLICK',
    last_event_at: ago(24),
    detected_at: ago(25),
    token_consumed: true,
    follow_up: null,
  },
  web_events: [
    { event_type: 'STOREFRONT_VISIT', at: ago(26), details: {} },
    { event_type: 'PRODUCT_DETAIL_VIEW', at: ago(25), details: {} },
    { event_type: 'WHATSAPP_CLICK', at: ago(24), details: { entry: 'STORE_NEED' } },
  ],
  messages: [
    {
      message_id: 'msg_1',
      direction: 'INBOUND',
      message_type: 'TEXT',
      text: 'Need it today',
      options: null,
      location: null,
      origin: 'CUSTOMER',
      message_kind: null,
      template_name: null,
      delivery_status: 'RECEIVED',
      timestamp: ago(23),
    },
    {
      message_id: 'msg_2',
      direction: 'INBOUND',
      message_type: 'LOCATION',
      text: null,
      options: null,
      location: { latitude: 19.12, longitude: 72.9 },
      origin: 'CUSTOMER',
      message_kind: null,
      template_name: null,
      delivery_status: 'RECEIVED',
      timestamp: ago(21),
    },
  ],
  recommendations: [
    discovery,
    {
      ...discovery,
      recommendation_id: 'rec_2',
      action: 'STORE_RESERVATION',
      proposed_at: ago(19),
      trace: {
        ...discovery.trace!,
        eligible: [],
        excluded: [],
        guardrail: { status: 'ALLOWED', reason_code: null, checked: 'CREATE_RESERVATION' },
      },
      reservation: {
        reservation_id: 'res_1',
        status: 'COMPLETED',
        store_id: 'st_north_2',
        store_name: 'HealthPlus Chemist',
        pickup_code: '482913',
        expires_at: ago(-1),
        quantity: 1,
        product_title: 'Vitamin C Glow Serum',
        variant_title: '30 ml',
        status_history: [
          { status: 'PENDING', at: ago(19) },
          { status: 'CONFIRMED', at: ago(17) },
          { status: 'READY', at: ago(14) },
          { status: 'CUSTOMER_ARRIVED', at: ago(8) },
          { status: 'COMPLETED', at: ago(7) },
        ],
      },
    },
  ],
  outcomes: [
    {
      purchase_type: 'OFFLINE',
      evidence: 'RESERVATION_COMPLETED',
      channel: 'SIMULATOR',
      store_id: 'st_north_2',
      store_name: 'HealthPlus Chemist',
      reservation_id: 'res_1',
      value: 795,
      currency: 'INR',
      timestamp: ago(7),
    },
  ],
};

describe('Journey timeline', () => {
  it('orders website → chat → decisions → hold → store steps, and ends on the pickup outcome', () => {
    expect(buildJourney(DETAIL).map((s) => s.title)).toEqual([
      'Visited the store',
      'Opened Vitamin C Glow Serum',
      'Tapped "Need it today?"',
      'Started a WhatsApp chat',
      'Shared a location',
      'Qwikspot looked for a store',
      'Hold placed at HealthPlus Chemist',
      'HealthPlus Chemist confirmed the hold',
      'Ready for pickup at HealthPlus Chemist',
      'Customer arrived at HealthPlus Chemist',
      'Picked up at HealthPlus Chemist — in-store purchase · ₹795 est.',
    ]);
    const hold = buildJourney(DETAIL).find((s) => s.title === 'Hold placed at HealthPlus Chemist')!;
    expect(hold.detail).toBe(
      '1 × Vitamin C Glow Serum 30 ml. Held 1 at HealthPlus Chemist. Stock was re-checked just before holding.',
    );
  });

  it('a refusal reads in words; with no purchase the journey ends on "No purchase recorded"', () => {
    const refused: ConversationDetail = {
      ...DETAIL,
      recommendations: [
        {
          ...DETAIL.recommendations[1]!,
          reservation: {
            ...DETAIL.recommendations[1]!.reservation!,
            status: 'CANCELLED',
            status_history: [
              { status: 'PENDING', at: ago(19) },
              { status: 'CANCELLED', at: ago(15), by: 'RETAILER', reason: 'NOT_ACTUALLY_IN_STOCK' },
            ],
          },
        },
      ],
      outcomes: [
        { ...DETAIL.outcomes![0]!, purchase_type: 'NONE', value: 0, evidence: 'WINDOW_CLOSED', timestamp: ago(1) },
      ],
    };
    const titles = buildJourney(refused).map((s) => s.title);
    expect(titles).toContain('HealthPlus Chemist refused: not actually in stock');
    expect(titles.at(-1)).toBe('No purchase recorded');
  });

  it('the conversation page shows the journey, and a pickup is "in-store purchase", never "Ordered: no"', async () => {
    renderAt(
      '/brand/conversations?c=conv_1',
      apiWith({
        '/api/brand/conversations': { conversations: [row({})] },
        '/api/brand/intents': { intents: [] },
        '/api/brand/conversations/conv_1': DETAIL,
        '/api/brand/demo': { reset_available: false },
      }),
    );
    const journey = await screen.findByRole('list', { name: 'Journey' });
    expect(
      within(journey).getByText('Picked up at HealthPlus Chemist — in-store purchase · ₹795 est.'),
    ).toBeInTheDocument();
    const panel = screen.getByLabelText('Intent and follow-up');
    expect(within(panel).getByText(/Bought: Picked up at HealthPlus Chemist — in-store purchase/)).toBeInTheDocument();
    expect(screen.queryByText(/Ordered: no/)).not.toBeInTheDocument();
    expect(screen.getByRole('log', { name: 'Messages' })).toBeInTheDocument();
  });
});

describe('synthetic history on lists', () => {
  const api = () =>
    apiWith({
      '/api/brand/conversations': {
        conversations: [
          row({ conversation_id: 'live', customer_ref: 'sim:judge_live' }),
          row({ conversation_id: 'h1', customer_ref: 'sim:hist_01', demo_history: true }),
          row({ conversation_id: 'h2', customer_ref: 'sim:hist_02', demo_history: true }),
        ],
      },
      '/api/brand/intents': { intents: [] },
      '/api/brand/demo': { reset_available: false },
    });

  it('hidden by default with a count; showing them labels each one; the choice is remembered', async () => {
    const view = renderAt('/brand/conversations', api());
    expect(await screen.findByRole('button', { name: /sim:judge_live/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sim:hist_01/ })).not.toBeInTheDocument();
    expect(screen.getByText(/2 synthetic records hidden/)).toBeInTheDocument();
    // UI-P3: "Live only | Live + demo history", and a "Demo" pill on each generated chat.
    fireEvent.click(screen.getByRole('button', { name: 'Live + demo history' }));
    const hist = await screen.findByRole('button', { name: /sim:hist_01/ });
    expect(within(hist).getByText('Demo')).toBeInTheDocument();
    expect(window.localStorage.getItem('qs_hide_synthetic')).toBe('false');
    view.unmount();
    renderAt('/brand/conversations', api());
    expect(await screen.findByRole('button', { name: /sim:hist_02/ })).toBeInTheDocument();
  });
});

describe('Settings', () => {
  it('shows the follow-up policy in words, conversation settings and the channel, with no edit controls', async () => {
    renderAt(
      '/brand/settings',
      apiWith({
        '/api/brand/settings': SETTINGS,
        '/api/brand/demo': { reset_available: false },
        '/api/brand/conversations': { conversations: [] },
      }),
    );
    const policy = await screen.findByRole('table', { name: 'Follow-up policy' });
    const cart = within(policy).getByText('Added to cart, then left').closest('tr')!;
    expect(cart).toHaveTextContent('On');
    expect(cart).toHaveTextContent('2 min');
    const store = within(policy).getByText('Asked for a store, then left').closest('tr')!;
    expect(store).toHaveTextContent('Off');
    expect(within(policy).getByText('Started checkout, then left').closest('tr')).toHaveTextContent('High');
    expect(screen.getByText(/at most one follow-up per customer every 1 day/)).toBeInTheDocument();
    expect(screen.getByText('Demo Beauty Co', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('http://localhost:5173')).toBeInTheDocument();
    expect(screen.getByText('In 4–5 days')).toBeInTheDocument();
    expect(screen.getByText(/nearest one within 25 km is still offered/)).toBeInTheDocument();
    expect(screen.getByText(/Simulator — WhatsApp once your number is connected/)).toBeInTheDocument();
    expect(
      screen.getByText('Apart from the storefronts above, settings are read-only in this prototype.'),
    ).toBeInTheDocument();
    // L4: the storefront list is the one editable setting; nothing else has an input or a save.
    expect(screen.getAllByRole('textbox')).toEqual([screen.getByLabelText('Add a storefront')]);
    expect(screen.queryByRole('button', { name: /save|edit/i })).not.toBeInTheDocument();
  });

  it('L4: the Brand Admin adds the Shopify store as an allowed storefront; a non-address is refused before saving', async () => {
    const api = apiWith({
      '/api/brand/settings': SETTINGS,
      '/api/brand/demo': { reset_available: false },
      '/api/brand/conversations': { conversations: [] },
      '/api/integrations/whatsapp': {
        enabled: false,
        status: 'NOT_CONNECTED',
        display_phone_number: null,
        verified_name: null,
      },
      '/api/brand/connections': { connections: [] },
    });
    renderAt('/brand/settings', api);
    const input = await screen.findByLabelText('Add a storefront');
    fireEvent.change(input, { target: { value: 'my store' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the store address');
    expect(api.patch).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'https://M6CCXZ-WK.myshopify.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/api/brand/settings/storefront-origins', {
        origins: ['http://localhost:5173', 'https://m6ccxz-wk.myshopify.com'],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove http://localhost:5173' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith('/api/brand/settings/storefront-origins', { origins: [] }),
    );
  });
});

describe('charts', () => {
  it('step conversion is the share that reached the next step', () => {
    expect(stepPct(12, 7)).toBe(58);
    expect(stepPct(0, 0)).toBeNull();
  });

  it('Insights draws the weekday chart and marks the problem day; the table fallback has the same numbers', async () => {
    renderAt(
      '/brand/insights',
      apiWith({
        '/api/brand/insights': INSIGHTS,
        '/api/brand/stores': { stores: [{ store_id: 'st_north_2', store_name: 'HealthPlus Chemist' }] },
        '/api/brand/demo': { reset_available: false },
        '/api/brand/conversations': { conversations: [] },
      }),
    );
    expect(await screen.findByRole('img', { name: /Store lookups by weekday: Monday 4/ })).toBeInTheDocument();
    expect(screen.getByText('problem day')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Show as table' })[1]!);
    const table = await screen.findByRole('table', { name: 'Demand vs availability by weekday' });
    expect(within(table).getByText('Saturday').closest('tr')).toHaveTextContent('6 (50%)');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Open HealthPlus Chemist →' })).toHaveAttribute(
        'href',
        '/brand/network#store-st_north_2',
      ),
    );
  });
});

describe('UI-P3 — Overview', () => {
  const overviewApi = (over: Record<string, unknown> = {}) =>
    apiWith({
      '/api/brand/insights': INSIGHTS,
      '/api/brand/conversations': { conversations: [row({ human_handoff: true, handoff_at: ago(14) })] },
      '/api/reservations': { reservations: [] },
      '/api/brand/stores': {
        stores: [{ store_id: 'st_north_2', store_name: 'HealthPlus Chemist', sku_count: 10, stock_updated_at: ago(5) }],
      },
      '/api/products': {
        products: [],
        retail_mappings_needing_attention: [],
        mapping_summary: { auto_matched: 1, needs_attention: 0 },
      },
      '/api/brand/settings': SETTINGS,
      '/api/brand/connections': { connections: [] },
      '/api/brand/demo': { reset_available: false },
      ...over,
    });

  it('"Needs your attention" sits above the journey; an unmet-demand card names its area', async () => {
    renderAt('/brand', overviewApi());
    const attention = await screen.findByRole('region', { name: 'Needs your attention' });
    const journey = await screen.findByRole('region', { name: 'Shopper journey' });
    expect(attention.compareDocumentPosition(journey) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const area = INSIGHTS.unmet_demand[0]!.area.replace(/\b\w/g, (c) => c.toUpperCase());
    expect(await within(attention).findByText(`Review unmet demand in ${area} →`)).toBeInTheDocument();
  });

  it('the journey stages show the same counts as the tiles and open their page with a filter', async () => {
    renderAt('/brand', overviewApi());
    const flow = await screen.findByRole('list', { name: 'Shopper journey' });
    const tiles = Object.fromEntries(kpis(INSIGHTS).map((k) => [k.key, k.value]));
    const stage = (name: RegExp) => within(flow).getByRole('link', { name });
    expect(stage(/^Intents caught: /)).toHaveTextContent(tiles.intents!);
    expect(stage(/^Conversations: /)).toHaveTextContent(tiles.conversations!);
    expect(stage(/^Holds: /)).toHaveTextContent(tiles.holds!);
    expect(stage(/^Picked up: /)).toHaveTextContent(tiles.pickups!);
    expect(screen.getByRole('link', { name: /^Online orders: / })).toHaveTextContent(tiles.online!);
    expect(stage(/^Intents caught: /)).toHaveAttribute('href', '/brand/conversations?tab=intents');
    expect(stage(/^Picked up: /)).toHaveAttribute('href', '/brand/reservations?filter=picked_up');
    fireEvent.click(stage(/^Intents caught: /));
    expect(await screen.findByRole('tab', { name: 'Intents', selected: true })).toBeInTheDocument();
  });

  it('nothing to do: a green check', async () => {
    renderAt(
      '/brand',
      overviewApi({
        '/api/brand/insights': { ...INSIGHTS, unmet_demand: [] },
        '/api/brand/conversations': { conversations: [] },
        '/api/brand/stores': { stores: [] },
      }),
    );
    expect(await screen.findByText('Nothing needs you right now.')).toBeInTheDocument();
  });
});

describe('UI-P3 — the judge tour', () => {
  const tourApi = (conversations: ConversationRow[] = []) =>
    apiWith({
      '/api/brand/insights': INSIGHTS,
      '/api/brand/conversations': { conversations },
      '/api/reservations': { reservations: [] },
      '/api/brand/stores': { stores: [] },
      '/api/products': {
        products: [],
        retail_mappings_needing_attention: [],
        mapping_summary: { auto_matched: 0, needs_attention: 0 },
      },
      '/api/brand/settings': SETTINGS,
      '/api/brand/connections': { connections: [] },
      '/api/brand/demo': { reset_available: true },
    });

  it('four steps; a live chat after the tour started ticks the first; it collapses to a pill and comes back', async () => {
    window.localStorage.setItem(
      'qs_judge_tour:brd_demo',
      JSON.stringify({ started: ago(5), done: {}, collapsed: false, dismissed: false }),
    );
    renderAt('/brand', tourApi([row({ last_inbound_at: ago(1), last_message_at: ago(1) })]));
    const tour = await screen.findByRole('complementary', { name: 'Try the live demo' });
    const steps = within(tour).getAllByRole('checkbox');
    expect(steps.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Open the shopper demo and ask about a product',
      'Watch the conversation appear in Conversations',
      'See the hold reach the store',
      'Ask Qwikspot how your brand did',
    ]);
    await waitFor(() => expect(steps[0]).toHaveAttribute('aria-checked', 'true'));
    expect(steps[2]).toHaveAttribute('aria-checked', 'false');
    // A manual tick, remembered for this viewer.
    fireEvent.click(steps[2]!);
    expect(steps[2]).toHaveAttribute('aria-checked', 'true');
    expect(JSON.parse(window.localStorage.getItem('qs_judge_tour:brd_demo')!).done['2']).toBe(true);
    fireEvent.click(within(tour).getByRole('button', { name: 'Collapse the checklist' }));
    const pill = screen.getByRole('button', { name: /Try the live demo: 2 of 4 steps done/ });
    expect(pill).toHaveTextContent('2/4');
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole('button', { name: 'Close the checklist' }));
    expect(screen.queryByRole('complementary', { name: 'Try the live demo' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the welcome note' }));
    expect(await screen.findByRole('complementary', { name: 'Try the live demo' })).toBeInTheDocument();
  });

  it('demo history never ticks a step', async () => {
    window.localStorage.setItem(
      'qs_judge_tour:brd_demo',
      JSON.stringify({ started: ago(5), done: {}, collapsed: false, dismissed: false }),
    );
    renderAt('/brand', tourApi([row({ demo_history: true, last_inbound_at: ago(1) })]));
    const tour = await screen.findByRole('complementary', { name: 'Try the live demo' });
    await new Promise((r) => setTimeout(r, 50));
    expect(within(tour).getAllByRole('checkbox')[0]).toHaveAttribute('aria-checked', 'false');
  });
});
