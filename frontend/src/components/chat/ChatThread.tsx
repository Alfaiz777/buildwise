import { useEffect, useRef } from 'react';
import type { ChatMessage, ChatOption } from '../../pages/brand/conversationTypes';
import { ChatBubble, type ChatMode } from './ChatBubble';

/** UI-P3: a small centred line between bubbles ("Hold placed at Wellness Mart"). */
export interface ChatEvent {
  id: string;
  at: string;
  text: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary';
}

/**
 * The conversation as a WhatsApp-style thread (Change 16). The same component serves the
 * shopper's phone (`customer`) and the Brand Console transcript (`brand`, read-only, with
 * internal labels). Only the latest message's choices are tappable, as in WhatsApp.
 */
export function ChatThread({
  messages,
  mode,
  onChoose,
  busy = false,
  empty,
  events = [],
}: {
  messages: ChatMessage[];
  mode: ChatMode;
  onChoose?: (option: ChatOption) => void;
  busy?: boolean;
  empty?: string;
  /** Brand transcript only: what happened between messages, in time order. */
  events?: ChatEvent[];
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length]);
  const lastOutbound = [...messages].reverse().find((m) => m.direction === 'OUTBOUND')?.message_id;
  const lastMessage = messages.at(-1)?.message_id;
  // Each event goes after the last message sent at or before it.
  const items: ({ kind: 'message'; m: ChatMessage } | { kind: 'event'; e: ChatEvent })[] = [];
  const pending = [...events].sort((a, b) => a.at.localeCompare(b.at));
  for (const m of messages) {
    while (pending.length && pending[0]!.at < m.timestamp) items.push({ kind: 'event', e: pending.shift()! });
    items.push({ kind: 'message', m });
  }
  for (const e of pending) items.push({ kind: 'event', e });
  return (
    <div className={`wa-thread wa-thread--${mode}`} role="log" aria-live="polite" aria-label="Messages">
      {messages.length === 0 && <p className="wa-empty">{empty ?? 'No messages yet.'}</p>}
      {items.map((item) =>
        item.kind === 'event' ? (
          <p key={`ev-${item.e.id}`} className={`wa-event wa-event--${item.e.tone ?? 'neutral'}`}>
            <span>{item.e.text}</span>
          </p>
        ) : (
          <ChatBubble
            key={item.m.message_id}
            message={item.m}
            mode={mode}
            onChoose={onChoose}
            last={item.m.message_id === lastMessage}
            choicesEnabled={mode === 'customer' && !busy && item.m.message_id === lastOutbound}
          />
        ),
      )}
      {busy && (
        <div className="wa-typing" aria-label="Typing">
          <span />
          <span />
          <span />
        </div>
      )}
      <div ref={end} />
    </div>
  );
}
