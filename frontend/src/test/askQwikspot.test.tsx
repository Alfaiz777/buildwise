import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext, type MeResponse } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import { pageOf, SUGGESTED_QUESTIONS, type AssistantAnswer } from '../pages/brand/askQwikspot';
import { overviewReads } from './brandFixtures';

/** L5 "Ask Qwikspot" in the Brand Console: the drawer on every page, the brief, summaries, "Ask about this". */

const BRAND: MeResponse = {
  scope: 'BRAND',
  role: 'BRAND_ADMIN',
  user: { user_id: 'a', email: 'admin@brand.test' },
  brand_id: 'brand_A',
  brand_name: 'Brand A',
};
const RETAIL: MeResponse = {
  scope: 'RETAIL',
  role: 'RETAIL_ADMIN',
  user: { user_id: 'r', email: 'owner@north.test' },
  brand_id: 'brand_A',
  brand_name: 'Brand A',
  retailer_id: 'rtl_north',
  retailer_name: 'Ahmedabad Retail Partners',
  store_id: 'st_1',
  store: {
    store_id: 'st_1',
    store_name: 'Wellness Mart',
    city: 'Ahmedabad',
    area: 'Satellite',
    address: 'Satellite Road',
    store_status: 'ACTIVE',
    store_hours: null,
  },
};

const answer = (over: Partial<AssistantAnswer> = {}): AssistantAnswer => ({
  answer: '1 hold is waiting on Wellness Mart.',
  handoff_brief: null,
  next_action: { label: 'Open reservations', page: 'RESERVATIONS', path: '/brand/reservations' },
  used: ['holds_now', 'stores'],
  source: 'AI',
  generated_at: '2026-10-16T06:00:00.000Z',
  latency_ms: 4200,
  ...over,
});

const STORES = {
  stores: [
    {
      store_id: 'st_1',
      store_name: 'Wellness Mart',
      city: 'Ahmedabad',
      area: 'Satellite',
      store_status: 'ACTIVE',
      retailer_id: 'rtl_north',
      retail_admin_user_id: null,
      sku_count: 12,
      stock_updated_at: null,
    },
  ],
};

function apiFor(me: MeResponse, extra: Record<string, unknown> = {}, ask?: (body: unknown) => Promise<unknown>) {
  const get = vi.fn(async (path: string) => {
    if (path === '/api/me') return me;
    if (path in extra) return extra[path];
    const overview = overviewReads(path);
    if (overview !== undefined) return overview;
    if (path === '/api/brand/demo') return { reset_available: false };
    if (path === '/api/brand/stores') return STORES;
    if (path === '/api/brand/retailers')
      return { retailers: [{ retailer_id: 'rtl_north', name: 'Ahmedabad Retail Partners', status: 'ACTIVE' }] };
    if (path === '/api/brand/users') return { users: [] };
    if (path.startsWith('/api/brand/retail-imports')) return { imports: [] };
    if (path === '/api/products') return { products: [], mapping_summary: {}, retail_mappings_needing_attention: [] };
    if (path === '/api/brand/connections') return { connections: [] };
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, body: unknown) => {
    if (path === '/api/brand/assistant/ask') return ask ? ask(body) : answer();
    throw new Error(`unexpected POST ${path}`);
  });
  return { get, post, patch: vi.fn(), put: vi.fn() } as unknown as ApiClient & {
    get: typeof get;
    post: typeof post;
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

afterEach(() => window.localStorage.clear());

describe('Ask Qwikspot — the drawer', () => {
  it('every Brand Console page has its own suggested questions', () => {
    expect(pageOf('/brand')).toBe('OVERVIEW');
    expect(pageOf('/brand/conversations')).toBe('CONVERSATIONS');
    expect(pageOf('/brand/reservations')).toBe('RESERVATIONS');
    expect(pageOf('/brand/insights')).toBe('INSIGHTS');
    expect(pageOf('/brand/network')).toBe('NETWORK');
    expect(pageOf('/brand/settings')).toBe('SETTINGS');
    for (const questions of Object.values(SUGGESTED_QUESTIONS)) expect(questions.length).toBeGreaterThan(0);
  });

  it('opens from the header on Overview, asks a suggested question with the page, shows the AI answer and its next action', async () => {
    const api = apiFor(BRAND, { '/api/brand/assistant/brief?days=7&include_history=true': answer() });
    renderAt('/brand', api);
    fireEvent.click(await screen.findByRole('button', { name: "Ask Qwikspot about your brand's data" }));
    const drawer = await screen.findByRole('dialog', { name: 'Ask Qwikspot' });
    const chips = within(within(drawer).getByRole('group', { name: 'Suggested questions' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(SUGGESTED_QUESTIONS.OVERVIEW);
    fireEvent.click(within(drawer).getByRole('button', { name: 'What should I fix first?' }));
    expect(await within(drawer).findByText('1 hold is waiting on Wellness Mart.')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/brand/assistant/ask', {
      question: 'What should I fix first?',
      page: 'OVERVIEW',
      days: 7,
      include_history: true,
    });
    expect(within(drawer).getByText('AI summary')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Open reservations →' })).toHaveAttribute(
      'href',
      '/brand/reservations',
    );
    expect(within(drawer).getByRole('link', { name: 'Reservations' })).toBeInTheDocument(); // "Based on"
  });

  it('a typed question on Network is sent with the page; a Quick summary is labelled as such', async () => {
    const api = apiFor(BRAND, {}, async () =>
      answer({ source: 'QUICK_SUMMARY', answer: 'Wellness Mart had stock for 1 of 4.' }),
    );
    renderAt('/brand/network', api);
    fireEvent.click(await screen.findByRole('button', { name: "Ask Qwikspot about your brand's data" }));
    const drawer = await screen.findByRole('dialog', { name: 'Ask Qwikspot' });
    expect(within(drawer).getByRole('button', { name: 'Which store needs attention?' })).toBeInTheDocument();
    fireEvent.change(within(drawer).getByLabelText('Your question'), { target: { value: 'Is Wellness Mart ok?' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Ask' }));
    expect(await within(drawer).findByText('Wellness Mart had stock for 1 of 4.')).toBeInTheDocument();
    expect(within(drawer).getByText('Quick summary')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/brand/assistant/ask', {
      question: 'Is Wellness Mart ok?',
      page: 'NETWORK',
      days: 7,
      include_history: true,
    });
  });

  it('"Ask about this" on a Network store opens the drawer with that store question asked', async () => {
    const api = apiFor(BRAND);
    renderAt('/brand/network', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Qwikspot about Wellness Mart' }));
    await screen.findByRole('dialog', { name: 'Ask Qwikspot' });
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/brand/assistant/ask', {
        question: 'How is Wellness Mart doing, and does it need attention?',
        page: 'NETWORK',
        days: 7,
        include_history: true,
      }),
    );
  });

  it('only in the Brand Console: the Store Console has no Ask Qwikspot', async () => {
    renderAt('/store', apiFor(RETAIL, { '/api/reservations?view=active': { reservations: [] } }));
    await screen.findAllByText(/Wellness Mart/);
    expect(screen.queryByRole('button', { name: "Ask Qwikspot about your brand's data" })).not.toBeInTheDocument();
  });
});

describe('the AI pieces on the pages', () => {
  it('Overview: the brief with its label and next action; it never blocks the page', async () => {
    renderAt(
      '/brand',
      apiFor(BRAND, {
        '/api/brand/assistant/brief?days=7&include_history=true': answer({ answer: 'A good week: 12 holds.' }),
      }),
    );
    const card = (await screen.findByText('A good week: 12 holds.')).closest('section')!;
    expect(within(card).getByText('This week in brief')).toBeInTheDocument();
    expect(within(card).getByText('AI summary')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open reservations →' })).toHaveAttribute(
      'href',
      '/brand/reservations',
    );
  });

  it('Overview: if the brief fails, the card is simply not shown and the page still renders', async () => {
    renderAt('/brand', apiFor(BRAND)); // no brief endpoint → it fails
    expect(await screen.findByRole('region', { name: 'Results' })).toBeInTheDocument();
    expect(screen.queryByText('This week in brief')).not.toBeInTheDocument();
  });

  it('Insights: "Ask about this" on a suggestion asks about that suggestion, on the Insights page', async () => {
    const api = apiFor(BRAND);
    renderAt('/brand/insights', api);
    const ask = await screen.findByRole('button', {
      name: /^Ask Qwikspot about: HealthPlus Chemist was the nearest store/,
    });
    fireEvent.click(ask);
    await screen.findByRole('dialog', { name: 'Ask Qwikspot' });
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, body] = api.post.mock.calls[0]! as [string, { question: string; page: string }];
    expect(body.page).toBe('INSIGHTS');
    expect(body.question).toMatch(/^About this suggestion: "HealthPlus Chemist was the nearest store/);
    expect(body.question).toMatch(/Why is this happening, and what should I do first\?$/);
  });

  it('Conversations: the summary and the handoff brief above the conversation', async () => {
    const DETAIL = {
      conversation_id: 'conv_1',
      customer_ref: 'sim:shopper',
      channel: 'SIMULATOR',
      status: 'OPEN',
      human_handoff: false,
      handoff_at: null,
      last_inbound_at: null,
      brand_display_name: 'Brand A',
      demo_history: false,
      intent: null,
      web_events: [],
      messages: [],
      recommendations: [],
      outcomes: [],
    };
    const api = apiFor(BRAND, {
      '/api/brand/conversations': {
        conversations: [
          {
            conversation_id: 'conv_1',
            customer_ref: 'sim:shopper',
            channel: 'SIMULATOR',
            status: 'OPEN',
            human_handoff: false,
            handoff_at: null,
            last_message_at: '2026-10-16T06:00:00.000Z',
            last_inbound_at: null,
            demo_history: false,
            intent: null,
          },
        ],
      },
      '/api/brand/conversations/conv_1': DETAIL,
      '/api/brand/conversations/conv_1/summary': answer({
        answer: 'The shopper wanted Vitamin C Glow Serum 30 ml; a hold at Wellness Mart is pending.',
        handoff_brief: 'They want a call back; no hold is open.',
        source: 'QUICK_SUMMARY',
      }),
    });
    renderAt('/brand/conversations?c=conv_1', api);
    const card = await screen.findByRole('region', { name: 'Conversation summary' });
    expect(await within(card).findByText(/^The shopper wanted Vitamin C Glow Serum 30 ml/)).toBeInTheDocument();
    expect(within(card).getByText('Handoff brief')).toBeInTheDocument();
    expect(within(card).getByText('They want a call back; no hold is open.')).toBeInTheDocument();
    expect(within(card).getByText('Quick summary')).toBeInTheDocument();
  });

  it('Overview: unticking "Include synthetic history" or picking 28 days rewrites the brief and scopes the drawer', async () => {
    const api = apiFor(BRAND, {
      '/api/brand/assistant/brief?days=7&include_history=true': answer({ answer: 'With history: 9 pickups.' }),
      '/api/brand/assistant/brief?days=7&include_history=false': answer({ answer: 'Live only: 0 pickups.' }),
      '/api/brand/assistant/brief?days=28&include_history=false': answer({ answer: 'Live, 28 days: 1 hold.' }),
    });
    renderAt('/brand', api);
    expect(await screen.findByText('With history: 9 pickups.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Include synthetic history/ }));
    expect(await screen.findByText('Live only: 0 pickups.')).toBeInTheDocument();
    expect(screen.getByText('Last 7 days · live activity only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Last 28 days' }));
    expect(await screen.findByText('Live, 28 days: 1 hold.')).toBeInTheDocument();
    expect(screen.getByText('The last 28 days in brief')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: "Ask Qwikspot about your brand's data" }));
    const drawer = await screen.findByRole('dialog', { name: 'Ask Qwikspot' });
    expect(within(drawer).getByText('Last 28 days · live activity only')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'How did we do this week?' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/brand/assistant/ask', {
        question: 'How did we do this week?',
        page: 'OVERVIEW',
        days: 28,
        include_history: false,
      }),
    );
  });

  it('Conversations: with "Hide synthetic history" on (the default), the drawer asks about live activity only', async () => {
    const api = apiFor(BRAND, {
      '/api/brand/conversations': { conversations: [] },
      '/api/brand/intents': { intents: [] },
    });
    renderAt('/brand/conversations', api);
    fireEvent.click(await screen.findByRole('button', { name: "Ask Qwikspot about your brand's data" }));
    const drawer = await screen.findByRole('dialog', { name: 'Ask Qwikspot' });
    expect(within(drawer).getByText('Last 7 days · live activity only')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Why did chats end without a hold this week?' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/api/brand/assistant/ask',
        expect.objectContaining({ include_history: false }),
      ),
    );
  });
});
