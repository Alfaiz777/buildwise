import type { InsightsResponse } from '../pages/brand/InsightsPage';
import type { BrandSettings } from '../pages/brand/SettingsPage';

/** Shared Brand Console fixtures (UI-3). Synthetic; shapes as the backend returns them. */

export const INSIGHTS: InsightsResponse = {
  period: { days: 7, from: '2026-09-28T10:00:00.000Z', to: '2026-10-05T10:00:00.000Z', timezone: 'Asia/Kolkata' },
  demo_history: { included: true, records: 120 },
  funnel: {
    intents: 40,
    follow_ups_sent: 12,
    conversations: 20,
    store_recommendations: 15,
    reservations: 12,
    completed: 7,
    outcomes: { OFFLINE: 7, ONLINE: 2, ALTERNATIVE: 1, NONE: 5 },
    value: { amount: 7950, currency: 'INR' },
  },
  conversion_by_action: [
    {
      action: 'STORE_RESERVATION',
      intended: ['OFFLINE'],
      outcomes: 9,
      recorded: { OFFLINE: 7, NONE: 2 },
      converted: 7,
      rate_pct: 78,
    },
  ],
  unmet_demand: [
    {
      sku: 'DBC-VCSERUM-50',
      label: 'Vitamin C Glow Serum 50 ml',
      area: 'andheri',
      weekday: 'saturday',
      count: 6,
      reasons: { OUT_OF_STOCK: 6 },
    },
  ],
  weekday: {
    days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((weekday, i) => ({
      weekday,
      lookups: weekday === 'saturday' ? 12 : 4 + (i % 2),
      no_store: weekday === 'saturday' ? 6 : 0,
      no_store_pct: weekday === 'saturday' ? 50 : 0,
      reservations: 1,
      completions: 1,
    })),
    reading: {
      kind: 'AVAILABILITY_PROBLEM',
      peak_weekday: 'saturday',
      text: "Saturday lookups for Vitamin C Glow Serum 30 ml were 2.7× the other days' average, but 50% found no store with stock (other days: 0%). This looks like an availability problem, not a demand problem.",
    },
  },
  fill_rate: [
    {
      store_id: 'st_north_2',
      store_name: 'Andheri Store',
      weekday: 'saturday',
      nearest: 8,
      had_stock: 2,
      fill_pct: 25,
      refusals: {},
    },
  ],
  suggestions: [
    {
      rule: 'RAISE_STOCK_BEFORE_PEAK',
      text: 'Andheri Store was the nearest store but out of stock of Vitamin C Glow Serum 30 ml 6 times on Saturdays in the last 7 days. Suggested: raise its Vitamin C Glow Serum 30 ml stock before Saturday.',
      evidence: { kind: 'EVENTS', ids: ['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5', 'evt_6'] },
    },
  ],
};

export const SETTINGS: BrandSettings = {
  brand_id: 'brd_demo',
  messaging: {
    display_name: 'Demo Beauty Co',
    logo_url: '/demo-products/demo-beauty-co-logo.png',
    powered_by_footer: true,
    handoff_enabled: true,
  },
  follow_up: {
    inactivity_minutes: 1,
    frequency_hours: 24,
    types: [
      { type: 'SEARCH_EXPLORATION', enabled: true, delay_minutes: 2, priority: 'NORMAL' },
      { type: 'PRODUCT_CONSIDERATION', enabled: true, delay_minutes: 2, priority: 'NORMAL' },
      { type: 'CART_ABANDONMENT', enabled: true, delay_minutes: 2, priority: 'NORMAL' },
      { type: 'CHECKOUT_ABANDONMENT', enabled: true, delay_minutes: 1, priority: 'HIGH' },
      { type: 'STORE_ORIENTED', enabled: false, delay_minutes: 1, priority: 'NORMAL' },
    ],
  },
  retail_freshness_hours: 24,
  attribution_window_minutes: 10,
  allowed_storefront_origins: ['http://localhost:5173'],
  channel: { mode: 'SIMULATOR' },
};

/** GET handlers for the Overview's extra reads, shared by tests that render /brand. */
export function overviewReads(path: string): unknown | undefined {
  if (path.startsWith('/api/brand/insights')) return INSIGHTS;
  if (path === '/api/brand/settings') return SETTINGS;
  if (path === '/api/brand/conversations') return { conversations: [] };
  if (path.startsWith('/api/reservations')) return { reservations: [] };
  return undefined;
}
