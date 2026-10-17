import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatBubble, isList, originLabel } from '../components/chat/ChatBubble';
import { ChatThread } from '../components/chat/ChatThread';
import type { ChatMessage } from '../pages/brand/conversationTypes';

/** Change 16: the structured, WhatsApp-compatible chat (customer and brand modes). */

const base = (over: Partial<ChatMessage>): ChatMessage => ({
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
  timestamp: '2026-10-05T10:00:00.000Z',
  ...over,
});
const parts = (over: Partial<NonNullable<ChatMessage['parts']>>): NonNullable<ChatMessage['parts']> => ({
  header: null,
  footer: null,
  location: null,
  cta_url: null,
  list_button: null,
  ...over,
});

const STORE_FOUND = base({
  text: '*Vitamin C Glow Serum 30 ml* · ₹795\nAvailable today at *HealthPlus Chemist*\n2.1 km · open until 21:00',
  options: [
    { option_id: 'hold:st_north_2', label: 'Hold at HealthPlus' },
    { option_id: 'other_stores', label: 'Other stores' },
    { option_id: 'buy_online', label: 'Buy online' },
  ],
  parts: parts({
    header: { type: 'IMAGE', url: 'http://localhost:5173/demo-products/vitamin-c-glow-serum.png', alt: 'Serum' },
    footer: 'Powered by Qwikspot',
  }),
});
const OTHER_STORES = base({
  message_id: 'msg_2',
  text: 'Other stores with *Vitamin C Glow Serum 30 ml* today:',
  options: [
    {
      option_id: 'hold:st_north_1',
      label: 'Wellness Mart',
      description: '7.1 km · open until 21:00',
      section: 'Stores near you',
    },
    { option_id: 'buy_online', label: 'Buy online', section: 'Or' },
  ],
  parts: parts({ list_button: 'Choose a store', footer: 'Powered by Qwikspot' }),
});
const PICKUP_PASS = base({
  message_id: 'msg_3',
  text: '✅ *On hold for you*\n1 × Vitamin C Glow Serum 30 ml\nPickup code: *482913*',
  options: [{ option_id: 'cancel:res_1', label: 'Cancel reservation' }],
  parts: parts({
    location: { name: 'HealthPlus Chemist', address: 'C.G. Road, Ahmedabad', latitude: 23.034, longitude: 72.5595 },
    footer: 'Powered by Qwikspot',
  }),
});

describe('ChatBubble — only what WhatsApp can render', () => {
  it('store found: image header, formatted body, three reply buttons, footer', () => {
    const onChoose = vi.fn();
    render(<ChatBubble message={STORE_FOUND} mode="customer" choicesEnabled onChoose={onChoose} />);
    expect(screen.getByRole('img', { name: 'Serum' })).toHaveAttribute('src', expect.stringContaining('serum.png'));
    expect(screen.getByText('HealthPlus Chemist', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Powered by Qwikspot')).toBeInTheDocument();
    const buttons = within(screen.getByRole('group', { name: 'Reply buttons' })).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Hold at HealthPlus', 'Other stores', 'Buy online']);
    fireEvent.click(buttons[0]!);
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ option_id: 'hold:st_north_2' }));
  });

  it('other stores: a list button opens a sheet with sections, rows and descriptions', () => {
    const onChoose = vi.fn();
    render(<ChatBubble message={OTHER_STORES} mode="customer" choicesEnabled onChoose={onChoose} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Choose a store/ }));
    const sheet = screen.getByRole('dialog', { name: 'Choose a store' });
    expect(within(sheet).getByText('Stores near you')).toBeInTheDocument();
    expect(within(sheet).getByText('Or')).toBeInTheDocument();
    expect(within(sheet).getByText('7.1 km · open until 21:00')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: /Wellness Mart/ }));
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ option_id: 'hold:st_north_1' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('pickup pass: body plus a location message that opens in Maps', () => {
    render(<ChatBubble message={PICKUP_PASS} mode="customer" />);
    expect(screen.getByText('482913', { selector: 'strong' })).toBeInTheDocument();
    const map = screen.getByRole('link', { name: /HealthPlus Chemist.*Open in Maps/ });
    expect(map).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=23.034,72.5595');
    expect(map).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('a CTA URL renders as one link button', () => {
    render(
      <ChatBubble
        message={base({
          text: 'Order online',
          parts: parts({ cta_url: { label: 'Buy online', url: 'https://x.test/p' } }),
        })}
        mode="customer"
      />,
    );
    expect(screen.getByRole('link', { name: 'Buy online' })).toHaveAttribute('href', 'https://x.test/p');
  });

  it('message text is escaped: markup shows as text, never as HTML', () => {
    const { container } = render(
      <ChatBubble message={base({ text: '<img src=x onerror="alert(1)"> *hi* <b>x</b>' })} mode="customer" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
    expect(screen.getByText('hi', { selector: 'strong' })).toBeInTheDocument();
  });

  it('customer mode shows no internal labels; brand mode shows who sent it and delivery failures', () => {
    const failed = base({ text: 'Hi', delivery_status: 'FAILED' });
    const { unmount } = render(<ChatBubble message={failed} mode="customer" />);
    expect(screen.queryByText('AI assistant')).not.toBeInTheDocument();
    expect(screen.queryByText(/Not delivered/)).not.toBeInTheDocument();
    unmount();
    render(<ChatBubble message={failed} mode="brand" />);
    expect(screen.getByText('AI assistant')).toBeInTheDocument();
    expect(screen.getByText(/Not delivered/)).toBeInTheDocument();
    expect(originLabel({ origin: 'PROACTIVE_FOLLOW_UP', message_kind: 'TEMPLATE' })).toBe('Follow-up · Template');
    expect(originLabel({ origin: 'HUMAN_AGENT', message_kind: null })).toBe('Team member');
    expect(originLabel({ origin: 'RESERVATION_UPDATE', message_kind: null })).toBe('Store update');
  });

  it('buttons vs list follows the backend rule (≤ 3 short choices without descriptions)', () => {
    expect(isList(STORE_FOUND.options!)).toBe(false);
    expect(isList(OTHER_STORES.options!)).toBe(true);
    expect(isList([{ option_id: 'a', label: 'A label longer than twenty' }])).toBe(true);
  });
});

describe('ChatThread', () => {
  it('only the latest brand message is tappable, and never in the brand transcript', () => {
    const { unmount } = render(<ChatThread messages={[STORE_FOUND, PICKUP_PASS]} mode="customer" onChoose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Hold at HealthPlus' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel reservation' })).toBeEnabled();
    unmount();
    render(<ChatThread messages={[STORE_FOUND, PICKUP_PASS]} mode="brand" />);
    expect(screen.getByRole('button', { name: 'Cancel reservation' })).toBeDisabled();
  });
});
