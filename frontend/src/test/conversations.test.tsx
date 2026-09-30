import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import { countdown, parseSimulatorFragment } from '../pages/brand/conversationTypes';

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
  template_name: 'buildwise_cart_reminder_v1',
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
      template_name: 'buildwise_cart_reminder_v1',
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

    const phone = await screen.findByLabelText('Simulator');
    expect(within(phone).getByText('Demo Beauty Co')).toBeInTheDocument();
    expect(within(phone).getByText('WhatsApp (simulated)')).toBeInTheDocument();
    expect(within(phone).getByText('Simulator')).toBeInTheDocument();
    expect(within(phone).getByText('Mock AI, deterministic')).toBeInTheDocument();
    expect(await within(phone).findByText(/Proactive follow-up · Template/)).toBeInTheDocument();
    expect(within(phone).getByText('Customer')).toBeInTheDocument();

    const panel = screen.getByLabelText('Intent and follow-up');
    expect(within(panel).getByText('Added to cart', { exact: false })).toBeInTheDocument();
    expect(within(panel).getByText('cart abandonment')).toBeInTheDocument();
    expect(within(panel).getByText(/Sent .* as a template message \(buildwise_cart_reminder_v1\)/)).toBeInTheDocument();
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

  it('prefills the simulator from the URL fragment and sends through the simulator route', async () => {
    const api = apiFor();
    renderAt('/brand/conversations#customer=shopper_3002&text=START_BUILDWISE_0123456789ABCDEFGHJKMNPQRS', api);
    const input = await screen.findByLabelText('Message');
    expect(input).toHaveValue('START_BUILDWISE_0123456789ABCDEFGHJKMNPQRS');
    expect(screen.getByLabelText('Simulator customer')).toHaveValue('shopper_3002');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Fallback (deterministic)');
    expect(api.post).toHaveBeenCalledWith(
      '/api/channels/simulator/messages',
      expect.objectContaining({
        simulator_customer_ref: 'shopper_3002',
        content: { type: 'TEXT', text: 'START_BUILDWISE_0123456789ABCDEFGHJKMNPQRS' },
      }),
    );
  });

  it('"Run due follow-ups" calls process-due and reports the result', async () => {
    const api = apiFor();
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ abandoned: 1, sent: 1, suppressed: 0, results: [] });
    renderAt('/brand/conversations', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Run due follow-ups' }));
    expect(
      await screen.findByText(/Due follow-ups: 1 sent, 0 suppressed, 1 sessions marked abandoned/),
    ).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/brand/follow-ups/process-due', {});
  });

  it('helpers: countdown and fragment parsing', () => {
    const now = Date.parse('2026-10-05T10:00:00.000Z');
    expect(countdown('2026-10-05T10:01:20.000Z', now)).toBe('in 1m 20s');
    expect(countdown('2026-10-05T10:00:05.000Z', now)).toBe('in 5s');
    expect(countdown('2026-10-05T09:00:00.000Z', now)).toBe('due now');
    expect(parseSimulatorFragment('#customer=c1&text=hi%20there')).toEqual({ customer: 'c1', text: 'hi there' });
    expect(parseSimulatorFragment('')).toEqual({ customer: null, text: null });
  });
});
