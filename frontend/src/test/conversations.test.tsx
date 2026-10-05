import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import { countdown } from '../pages/brand/conversationTypes';

const ME: MeResponse = {
  scope: 'BRAND',
  role: 'BRAND_ADMIN',
  user: { user_id: 'a', email: 'admin@brand.test' },
  brand_id: 'brand_A',
  brand_name: 'Demo Beauty Co',
};

const FOLLOW_UP_SENT = {
  decision: 'FOLLOW_UP_ELIGIBLE',
  reason: 'ELIGIBLE',
  status: 'SENT',
  evaluated_at: '2026-10-05T10:00:00.000Z',
  due_at: '2026-10-05T10:02:00.000Z',
  priority: 'NORMAL',
  message_kind: 'TEMPLATE',
  template_name: 'qwikspot_cart_reminder_v1',
  sent_at: '2026-10-05T10:02:05.000Z',
};
const INTENT = {
  intent_id: 'int_1',
  who: 'sim:shopper_3002',
  anonymous: false,
  intent_stage: 'CART',
  intent_strength: 'HIGH_INTENT',
  intent_type: 'CART_ABANDONMENT',
  status: 'ABANDONED',
  product_title: 'Vitamin C Glow Serum',
  variant_title: '30 ml',
  matched_category: null,
  last_event: 'ADD_TO_CART',
  last_event_at: '2026-10-05T10:00:00.000Z',
  detected_at: '2026-10-05T09:59:00.000Z',
  token_consumed: false,
  follow_up: FOLLOW_UP_SENT,
};
const ANONYMOUS = {
  ...INTENT,
  intent_id: 'int_2',
  who: 'visitor abc123',
  anonymous: true,
  intent_type: 'PRODUCT_EXPLORATION',
  intent_stage: 'PRODUCT_VIEW',
  follow_up: {
    ...FOLLOW_UP_SENT,
    decision: 'FOLLOW_UP_NOT_ELIGIBLE',
    reason: 'WEAK_INTENT',
    status: 'NOT_ELIGIBLE',
    sent_at: null,
    due_at: null,
  },
};
const ROW = {
  conversation_id: 'conv_1',
  customer_ref: 'sim:shopper_3002',
  channel: 'SIMULATOR',
  status: 'OPEN',
  human_handoff: false,
  last_message_at: '2026-10-05T10:03:00.000Z',
  last_inbound_at: '2026-10-05T10:03:00.000Z',
  intent: INTENT,
};
const DETAIL = {
  ...ROW,
  brand_display_name: 'Demo Beauty Co',
  web_events: [
    { event_type: 'PRODUCT_VIEW', at: '2026-10-05T09:59:00.000Z', details: {} },
    { event_type: 'ADD_TO_CART', at: '2026-10-05T10:00:00.000Z', details: {} },
  ],
  messages: [
    {
      message_id: 'msg_1',
      direction: 'OUTBOUND',
      message_type: 'TEMPLATE',
      text: 'Hi, this is Demo Beauty Co. You still have Vitamin C Glow Serum (30 ml) in your cart.\n\nReply STOP to opt out.',
      options: null,
      location: null,
      origin: 'PROACTIVE_FOLLOW_UP',
      message_kind: 'TEMPLATE',
      template_name: 'qwikspot_cart_reminder_v1',
      delivery_status: 'DELIVERED',
      timestamp: '2026-10-05T10:02:05.000Z',
    },
    {
      message_id: 'msg_2',
      direction: 'INBOUND',
      message_type: 'TEXT',
      text: 'Is it good for oily skin?',
      options: null,
      location: null,
      origin: 'CUSTOMER',
      message_kind: null,
      template_name: null,
      delivery_status: 'RECEIVED',
      timestamp: '2026-10-05T10:03:00.000Z',
    },
  ],
  recommendations: [],
};

function apiFor(): ApiClient {
  const get = vi.fn(async (path: string) => {
    if (path === '/api/me') return ME;
    if (path === '/api/brand/conversations') return { conversations: [ROW] };
    if (path === '/api/brand/intents') return { intents: [INTENT, ANONYMOUS] };
    if (path === '/api/brand/conversations/conv_1') return DETAIL;
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async () => ({
    conversation_id: 'conv_1',
    inbound_message_id: 'msg_3',
    outbound_messages: [],
    decision: {
      recommendation_id: 'rec_1',
      action: 'NO_ACTION',
      guardrail_status: 'ALLOWED',
      runtime: 'MOCK',
      decision_source: 'DETERMINISTIC_FALLBACK',
      executed_action: null,
      policy_reason: null,
    },
  }));
  return {
    get: get as ApiClient['get'],
    post: post as ApiClient['post'],
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

describe('Brand Console — Conversations & intents', () => {
  it('lists conversations with intent and follow-up status; the detail shows the chat and the intent panel', async () => {
    renderAt('/brand/conversations', apiFor());
    fireEvent.click(await screen.findByRole('button', { name: /sim:shopper_3002/ }));

    // The read-only transcript: the shopper's chat, with internal labels for the brand.
    const transcript = await screen.findByRole('log', { name: 'Messages' });
    expect(await within(transcript).findByText('Follow-up · Template')).toBeInTheDocument();
    expect(within(transcript).getByText('Customer')).toBeInTheDocument();
    expect(within(transcript).getByText('Is it good for oily skin?')).toBeInTheDocument();

    const panel = screen.getByLabelText('Intent and follow-up');
    expect(within(panel).getByText('Added to cart', { exact: false })).toBeInTheDocument();
    expect(within(panel).getByText('cart abandonment')).toBeInTheDocument();
    expect(within(panel).getByText(/Sent .* as a template message \(qwikspot_cart_reminder_v1\)/)).toBeInTheDocument();
    expect(within(panel).getByText('Replied: yes')).toBeInTheDocument();
  });

  it('the Intents tab shows every intent, anonymous and not-eligible included, with the reason in plain words', async () => {
    renderAt('/brand/conversations', apiFor());
    fireEvent.click(await screen.findByRole('tab', { name: 'Intents' }));
    expect(await screen.findByText('visitor abc123')).toBeInTheDocument();
    expect(screen.getByText('Intent too weak for a follow-up (browsing only).')).toBeInTheDocument();
  });

  it('filters: "Not eligible" hides a conversation whose follow-up was sent', async () => {
    renderAt('/brand/conversations', apiFor());
    await screen.findByRole('button', { name: /sim:shopper_3002/ });
    fireEvent.click(screen.getByRole('button', { name: 'Not eligible' }));
    expect(screen.queryByRole('button', { name: /sim:shopper_3002/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sent' }));
    expect(screen.getByRole('button', { name: /sim:shopper_3002/ })).toBeInTheDocument();
  });

  it('the Brand Console has no simulator: no composer, no customer-ref input, no location presets', async () => {
    const api = apiFor();
    renderAt('/brand/conversations#customer=shopper_3002&text=hello', api);
    fireEvent.click(await screen.findByRole('button', { name: /sim:shopper_3002/ }));
    await screen.findByRole('log', { name: 'Messages' });
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Simulator customer')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share location' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('"Process due work now" calls process-due and reports the result', async () => {
    const api = apiFor();
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ abandoned: 1, sent: 1, suppressed: 0, results: [] });
    renderAt('/brand/conversations', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Process due work now' }));
    expect(
      (await screen.findAllByText(/Due work processed: 1 follow-up sent, 0 suppressed, 1 session marked abandoned/))
        .length,
    ).toBeGreaterThan(0);
    expect(api.post).toHaveBeenCalledWith('/api/brand/follow-ups/process-due', {});
  });

  it('helpers: countdown', () => {
    const now = Date.parse('2026-10-05T10:00:00.000Z');
    expect(countdown('2026-10-05T10:01:20.000Z', now)).toBe('in 1m 20s');
    expect(countdown('2026-10-05T10:00:05.000Z', now)).toBe('in 5s');
    expect(countdown('2026-10-05T09:00:00.000Z', now)).toBe('due now');
  });
});

const TRACED = {
  ...DETAIL,
  messages: [
    ...DETAIL.messages,
    {
      message_id: 'msg_4',
      direction: 'OUTBOUND',
      message_type: 'INTERACTIVE',
      text: 'Done — 1 × Vitamin C Glow Serum 30 ml is on hold for you at Andheri Store.\nPickup code: 004271\nDirections: https://www.google.com/maps/search/?api=1&query=19.1364,72.8296',
      options: [{ option_id: 'cancel:res_1', label: 'Cancel reservation' }],
      location: null,
      origin: 'AUTOMATED_REPLY',
      message_kind: 'SESSION',
      template_name: null,
      delivery_status: 'DELIVERED',
      timestamp: '2026-10-05T10:05:00.000Z',
    },
  ],
  recommendations: [
    {
      recommendation_id: 'rec_1',
      action: 'STORE_DISCOVERY',
      runtime: 'MOCK',
      decision_source: 'AGENT',
      guardrail_status: 'ALLOWED',
      guardrail_reason: null,
      rationale_summary: 'Nearest eligible store is Andheri Store; 2 store(s) excluded by verified reasons.',
      proposed_at: '2026-10-05T10:04:00.000Z',
      reservation: null,
      trace: {
        context_hash: 'a'.repeat(64),
        context_summary: { intent_type: 'STORE_ORIENTED', location: 'SHARED', messages: 3, pending_proposal: false },
        tool_calls: [
          {
            call_id: 'tc_1',
            tool: 'find_nearby_stores',
            kind: 'READ',
            phase: 'DECIDE',
            input: { variant_id: 'var_2001' },
            output_summary: { status: 'OK', eligible: 1, excluded: 2 },
            status: 'EXECUTED',
            reason_code: null,
            duration_ms: 3.2,
          },
        ],
        eligible: [{ store_id: 'st_north_2', store_name: 'Andheri Store', distance_km: 7.6, variant_id: 'var_2001' }],
        excluded: [
          {
            store_id: 'st_north_3',
            store_name: 'Powai Store',
            reason: 'OUT_OF_STOCK',
            distance_km: 0.7,
            variant_id: 'var_2001',
          },
          {
            store_id: 'st_north_1',
            store_name: 'Bandra Store',
            reason: 'TOO_FAR',
            distance_km: 10.6,
            variant_id: 'var_2001',
          },
        ],
        guardrail: { status: 'ALLOWED', reason_code: null, checked: 'OFFERED_STORES' },
        executed_action: null,
        repaired: false,
        fallback_reason: null,
      },
    },
    {
      recommendation_id: 'rec_2',
      action: 'STORE_RESERVATION',
      runtime: 'MOCK',
      decision_source: 'AGENT',
      guardrail_status: 'ALLOWED',
      guardrail_reason: null,
      rationale_summary: 'Customer confirmed the offered hold.',
      proposed_at: '2026-10-05T10:05:00.000Z',
      reservation: {
        reservation_id: 'res_1',
        status: 'PENDING',
        store_id: 'st_north_2',
        store_name: 'Andheri Store',
        pickup_code: '004271',
        expires_at: '2026-10-05T12:05:00.000Z',
      },
      trace: {
        context_hash: 'b'.repeat(64),
        context_summary: { intent_type: 'STORE_ORIENTED', location: 'SHARED', messages: 4, pending_proposal: true },
        tool_calls: [],
        eligible: [],
        excluded: [],
        guardrail: { status: 'ALLOWED', reason_code: null, checked: 'CREATE_RESERVATION' },
        executed_action: { tool: 'create_reservation', status: 'EXECUTED', reason_code: null, reservation_id: 'res_1' },
        repaired: false,
        fallback_reason: null,
      },
    },
  ],
};

describe('Brand Console — M5 decision trace and reservations', () => {
  function api5(): ApiClient {
    const api = apiFor();
    const base = api.get as (path: string) => Promise<unknown>;
    const get = vi.fn(async (path: string) => {
      if (path === '/api/brand/conversations/conv_1') return TRACED;
      if (path.startsWith('/api/reservations'))
        return {
          reservations: [
            {
              reservation_id: 'res_1',
              store_id: 'st_north_2',
              store_name: 'Andheri Store',
              product_title: 'Vitamin C Glow Serum',
              variant_title: '30 ml',
              sku: 'DBC-VCSERUM-30',
              quantity: 1,
              status: 'PENDING',
              active: true,
              customer_display: 'Customer •••• 4821',
              created_at: '2026-10-05T10:05:00.000Z',
              expires_at: '2026-10-05T12:05:00.000Z',
              conversation_id: 'conv_1',
            },
          ],
        };
      return base(path);
    });
    return { ...api, get: get as ApiClient['get'] };
  }

  it('"Why Qwikspot did this": a plain sentence per decision, safety check in words, technical details collapsed', async () => {
    renderAt('/brand/conversations', api5());
    fireEvent.click(await screen.findByRole('button', { name: /sim:shopper_3002/ }));
    expect(await screen.findByText('Why Qwikspot did this')).toBeInTheDocument();
    const offer = screen.getByRole('article', { name: 'Store discovery' });
    expect(
      within(offer).getByText(
        'Offered Andheri Store (7.6 km) because Powai Store (0.7 km) is out of stock and Bandra Store (10.6 km) is too far.',
      ),
    ).toBeInTheDocument();
    const hold = screen.getByRole('article', { name: 'Store reservation' });
    expect(
      within(hold).getByText('Held 1 at Andheri Store. Stock was re-checked just before holding.'),
    ).toBeInTheDocument();
    expect(within(hold).getByText('Safety check passed')).toBeInTheDocument();
    expect(screen.getAllByText('Mock AI · deterministic')).toHaveLength(2);
    // Jargon stays under Technical details: the visible header and sentence are plain words.
    for (const card of [offer, hold]) {
      expect(card.querySelector('.trace-card__head')!.textContent).not.toMatch(/guardrail|tool/i);
      expect(card.querySelector('.why-sentence')!.textContent).not.toMatch(/guardrail|tool/i);
    }

    fireEvent.click(within(hold).getByText('Technical details'));
    expect(within(hold).getByText(/Allowed after re-checking create reservation on fresh data/)).toBeInTheDocument();
    expect(within(hold).getByText(/Andheri Store · pending · pickup code/)).toBeInTheDocument();
    fireEvent.click(within(offer).getByText('Technical details'));
    expect(await screen.findByText('excluded: out of stock')).toBeInTheDocument();
    expect(screen.getByText('excluded: too far')).toBeInTheDocument();
    expect(screen.getByText('Tool calls (1)')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /google\.com\/maps/ });
    expect(link).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=19.1364,72.8296');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('the Reservations page lists status, store, product, masked customer and outcome; a row opens its conversation', async () => {
    renderAt('/brand/reservations', api5());
    expect(await screen.findByText('Customer •••• 4821')).toBeInTheDocument();
    const row = screen.getByText('Customer •••• 4821').closest('tr')!;
    expect(within(row).getByText('Pending')).toBeInTheDocument();
    expect(within(row).getByText('Andheri Store')).toBeInTheDocument();
    expect(within(row).getByText(/Vitamin C Glow Serum/)).toBeInTheDocument();
    expect(within(row).getByText(/In progress/)).toBeInTheDocument();
    fireEvent.click(row);
    expect(await screen.findByRole('log', { name: 'Messages' })).toBeInTheDocument();
  });
});
