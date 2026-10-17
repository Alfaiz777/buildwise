import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import { ChatThread } from '../components/chat/ChatThread';
import type { ShopperChat, ShopperMessage } from '../lib/shopperApi';
import { forgetConversationSummaries } from '../pages/brand/AiCards';
import type { ChatMessage } from '../pages/brand/conversationTypes';
import { ShopperPhone } from '../pages/shopper/ShopperPhone';

/** L9: the handoff brief in the Handoff inbox, and suggested replies after an answer. */

const ME: MeResponse = {
  scope: 'BRAND',
  role: 'BRAND_ADMIN',
  user: { user_id: 'a', email: 'admin@brand.test' },
  brand_id: 'brand_A',
  brand_name: 'Demo Beauty Co',
};

const message = (over: Partial<ChatMessage>): ChatMessage => ({
  message_id: 'msg_1',
  direction: 'OUTBOUND',
  message_type: 'INTERACTIVE',
  text: null,
  options: null,
  location: null,
  parts: null,
  origin: 'AUTOMATED_REPLY',
  message_kind: 'SESSION',
  template_name: null,
  delivery_status: 'SENT',
  timestamp: '2026-10-17T10:00:00.000Z',
  ...over,
});

// ---------------------------------------------------------------- the handoff brief

const HANDOFF_ROW = {
  conversation_id: 'conv_h',
  customer_ref: 'sim:shopper_7781',
  channel: 'SIMULATOR',
  status: 'OPEN',
  human_handoff: true,
  handoff_at: '2026-10-17T09:58:00.000Z',
  last_message_at: '2026-10-17T10:00:00.000Z',
  last_inbound_at: '2026-10-17T10:00:00.000Z',
  intent: null,
};
const OTHER_ROW = { ...HANDOFF_ROW, conversation_id: 'conv_o', customer_ref: 'sim:shopper_1200', human_handoff: false };
const BRIEF =
  'Wants Vitamin C Glow Serum 30 ml; asked for a person after 6 messages.\nAlready tried: nearby stores shown (HealthPlus Chemist); a hold at HealthPlus Chemist, cancelled (the store refused: damaged).';
const SUMMARY = {
  answer: 'The shopper wanted Vitamin C Glow Serum 30 ml; a hold at HealthPlus Chemist is cancelled.',
  handoff_brief: BRIEF,
  next_action: null,
  used: ['conversation'],
  source: 'QUICK_SUMMARY',
  generated_at: '2026-10-17T10:00:01.000Z',
  latency_ms: 20,
};

function inboxApi(summary: Promise<unknown> | (() => Promise<unknown>)) {
  const get = vi.fn(async (path: string) => {
    if (path === '/api/me') return ME;
    if (path === '/api/brand/conversations') return { conversations: [HANDOFF_ROW, OTHER_ROW] };
    if (path === '/api/brand/intents') return { intents: [] };
    if (path === '/api/brand/conversations/conv_h/summary') return typeof summary === 'function' ? summary() : summary;
    if (path === '/api/brand/conversations/conv_h')
      return {
        ...HANDOFF_ROW,
        brand_display_name: 'Demo Beauty Co',
        web_events: [],
        messages: [],
        recommendations: [],
      };
    throw new Error(`unexpected GET ${path}`);
  });
  return { get, post: vi.fn(), patch: vi.fn(), upload: vi.fn() } as unknown as ApiClient & { get: typeof get };
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

describe('the handoff brief in the Handoff inbox', () => {
  afterEach(() => forgetConversationSummaries());

  it('loads after the list: the list shows first, then each handoff item gets its brief with its label', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    const api = inboxApi(new Promise((r) => (resolve = r)));
    renderAt('/brand/conversations', api);
    // The list is there while the brief is still loading.
    const item = (await screen.findByText('sim:shopper_7781')).closest('li')!;
    expect(screen.getByText('sim:shopper_1200')).toBeInTheDocument();
    expect(within(item).queryByLabelText('Handoff brief')).not.toBeInTheDocument();

    await act(async () => resolve(SUMMARY));
    const brief = await within(item).findByLabelText('Handoff brief');
    expect(brief).toHaveTextContent('Wants Vitamin C Glow Serum 30 ml');
    expect(brief).toHaveTextContent('Already tried: nearby stores shown (HealthPlus Chemist)');
    expect(within(brief).getByText('Quick summary')).toBeInTheDocument();
    // Only handoff items get one; never a shopper's name or number.
    const other = screen.getByText('sim:shopper_1200').closest('li')!;
    expect(within(other).queryByLabelText('Handoff brief')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/api/brand/conversations/conv_o/summary');
  });

  it('an AI brief is labelled "AI summary"; a failed brief leaves the item as it was', async () => {
    renderAt('/brand/conversations', inboxApi(Promise.resolve({ ...SUMMARY, source: 'AI' })));
    const item = (await screen.findByText('sim:shopper_7781')).closest('li')!;
    const brief = await within(item).findByLabelText('Handoff brief');
    expect(within(brief).getByText('AI summary')).toBeInTheDocument();
  });

  it('a failed brief: the inbox still renders, with no brief', async () => {
    forgetConversationSummaries();
    renderAt(
      '/brand/conversations',
      inboxApi(() => Promise.reject(new Error('down'))),
    );
    const item = (await screen.findByText('sim:shopper_7781')).closest('li')!;
    await act(async () => undefined);
    expect(within(item).queryByLabelText('Handoff brief')).not.toBeInTheDocument();
  });

  it('opened: the brief sits at the top of the "Needs a person" panel, shown once, from the same request', async () => {
    const api = inboxApi(Promise.resolve(SUMMARY));
    renderAt('/brand/conversations', api);
    fireEvent.click(await screen.findByText('sim:shopper_7781'));
    const panel = await screen.findByLabelText('Needs a person');
    const brief = await within(panel).findByLabelText('Handoff brief');
    expect(within(brief).getByText('Handoff brief')).toBeInTheDocument();
    expect(within(brief).getByText('Quick summary')).toBeInTheDocument();
    // The conversation summary above does not repeat it.
    const summary = await screen.findByLabelText('Conversation summary');
    expect(within(summary).queryByText('Handoff brief')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- suggested replies

const PRODUCT_ANSWER = message({
  message_id: 'msg_2',
  text: '*Mineral Sunscreen SPF 50* — from our product information:\n• Skin Type: sensitive, all',
  options: [
    { option_id: 'qr:stores:en:Mineral Sunscreen SPF 50', label: 'Show stores near me' },
    { option_id: 'qr:compare:en:Ultra-Light Gel Sunscreen SPF 50', label: 'Compare with Gel' },
    { option_id: 'qr:person:en', label: 'Talk to a person' },
  ],
  parts: { header: null, footer: 'Powered by Qwikspot', location: null, cta_url: null, list_button: null },
});
const HOLD_CONFIRMED = message({
  message_id: 'msg_3',
  text: '✅ *On hold for you*\n1 × Vitamin C Glow Serum 30 ml',
  options: [{ option_id: 'cancel:res_1', label: 'Cancel reservation' }],
});
const SHOPPER = message({
  message_id: 'msg_4',
  direction: 'INBOUND',
  message_type: 'TEXT',
  text: 'thanks',
  origin: 'CUSTOMER',
  message_kind: null,
});

describe('suggested replies on the web chat', () => {
  it('a product answer: chips under the last message, not the message buttons', () => {
    render(<ChatThread messages={[PRODUCT_ANSWER]} mode="customer" onChoose={vi.fn()} />);
    const chips = within(screen.getByRole('group', { name: 'Suggested replies' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['Show stores near me', 'Compare with Gel', 'Talk to a person']);
    expect(chips.every((c) => !c.hasAttribute('disabled'))).toBe(true);
    expect(screen.queryByRole('group', { name: 'Reply buttons' })).not.toBeInTheDocument();
  });

  it('once the shopper has answered, the chips are gone; a hold confirmation keeps its own button and has no chips', () => {
    const { unmount } = render(<ChatThread messages={[PRODUCT_ANSWER, SHOPPER]} mode="customer" onChoose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Suggested replies' })).not.toBeInTheDocument();
    unmount();
    render(<ChatThread messages={[HOLD_CONFIRMED]} mode="customer" onChoose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Suggested replies' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel reservation' })).toBeEnabled();
  });

  it('the Brand Console transcript shows them, read-only', () => {
    render(<ChatThread messages={[PRODUCT_ANSWER, SHOPPER]} mode="brand" />);
    const chips = within(screen.getByRole('group', { name: 'Suggested replies' })).getAllByRole('button');
    expect(chips.every((c) => c.hasAttribute('disabled'))).toBe(true);
  });

  it('a tapped chip is sent as the shopper message (its text is written by the backend from the choice)', async () => {
    const shopperMessage = (m: ChatMessage): ShopperMessage => ({ ...m, from: 'BRAND' }) as ShopperMessage;
    const chat = {
      brand: { brand_id: 'brand_A', display_name: 'Demo Beauty Co', logo_url: null },
      start: vi.fn(),
      send: vi.fn(async () => ({})),
      messages: vi.fn(async () => ({ conversation_id: 'conv_1', messages: [shopperMessage(PRODUCT_ANSWER)] })),
    } as unknown as ShopperChat;
    render(<ShopperPhone chat={chat} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show stores near me' }));
    expect(chat.send).toHaveBeenCalledWith({
      type: 'INTERACTIVE_REPLY',
      option_id: 'qr:stores:en:Mineral Sunscreen SPF 50',
    });
  });

  it('Hinglish choices render as they come', () => {
    const hinglish = message({
      options: [
        { option_id: 'qr:stores:hi:Mineral Sunscreen SPF 50', label: 'Paas ke store dikhao' },
        { option_id: 'qr:person:hi', label: 'Kisi se baat karao' },
      ],
    });
    render(<ChatThread messages={[hinglish]} mode="customer" onChoose={vi.fn()} />);
    expect(
      within(screen.getByRole('group', { name: 'Suggested replies' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Paas ke store dikhao', 'Kisi se baat karao']);
  });
});
