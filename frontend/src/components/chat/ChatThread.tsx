import { useEffect, useRef } from 'react';
import type { ChatMessage, ChatOption } from '../../pages/brand/conversationTypes';
import { ChatBubble, type ChatMode } from './ChatBubble';

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
}: {
  messages: ChatMessage[];
  mode: ChatMode;
  onChoose?: (option: ChatOption) => void;
  busy?: boolean;
  empty?: string;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length]);
  const lastOutbound = [...messages].reverse().find((m) => m.direction === 'OUTBOUND')?.message_id;
  return (
    <div className="wa-thread" role="log" aria-live="polite" aria-label="Messages">
      {messages.length === 0 && <p className="wa-empty">{empty ?? 'No messages yet.'}</p>}
      {messages.map((m) => (
        <ChatBubble
          key={m.message_id}
          message={m}
          mode={mode}
          onChoose={onChoose}
          choicesEnabled={mode === 'customer' && !busy && m.message_id === lastOutbound}
        />
      ))}
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
