import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatComposer, type ComposerSend } from '../../components/chat/ChatComposer';
import { ChatThread } from '../../components/chat/ChatThread';
import { ShopperApiError, ShopperChat, type ShopperBrand, type ShopperMessage } from '../../lib/shopperApi';
import type { ChatMessage, ChatOption } from '../brand/conversationTypes';

const POLL_MS = 3_000;

/** Shopper messages carry no internal labels; the bubble needs only direction and parts. */
const asChat = (m: ShopperMessage): ChatMessage => ({
  ...m,
  origin: m.from === 'SHOPPER' ? 'CUSTOMER' : 'AUTOMATED_REPLY',
  message_kind: null,
  template_name: null,
});

/**
 * The brand's WhatsApp chat as the shopper sees it (Change 16): brand header, the thread,
 * buttons and lists, location sharing, and live store updates (polled every 3 s). Used
 * full-screen on /chat and docked beside the demo store on desktop.
 */
export function ShopperPhone({
  chat,
  initialDraft = '',
  onClose,
  className,
}: {
  chat: ShopperChat;
  initialDraft?: string;
  onClose?: () => void;
  className?: string;
}) {
  const [brand, setBrand] = useState<ShopperBrand | null>(chat.brand);
  const [messages, setMessages] = useState<ShopperMessage[]>([]);
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef<string | undefined>(undefined);

  useEffect(() => setDraft(initialDraft), [initialDraft]);

  const merge = useCallback((incoming: ShopperMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((current) => {
      const seen = new Set(current.map((m) => m.message_id));
      const next = [...current, ...incoming.filter((m) => !seen.has(m.message_id))].sort((a, b) =>
        a.message_id.localeCompare(b.message_id),
      );
      lastId.current = next.at(-1)?.message_id;
      return next;
    });
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await chat.messages(lastId.current);
      merge(res.messages);
    } catch {
      // a missed poll is retried on the next tick
    }
  }, [chat, merge]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = chat.brand ?? (await chat.start());
        if (!cancelled) setBrand(b);
        await poll();
      } catch (err) {
        if (!cancelled) setError(err instanceof ShopperApiError ? err.message : 'The chat is not available right now.');
      }
    })();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [chat, poll]);

  const send = async (content: ComposerSend | { type: 'INTERACTIVE_REPLY'; option_id: string }) => {
    setBusy(true);
    setError(null);
    try {
      await chat.send(content);
      if (content.type === 'TEXT') setDraft('');
      await poll();
    } catch (err) {
      setError(err instanceof ShopperApiError ? err.message : 'Your message could not be sent. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const name = brand?.display_name ?? 'Demo Beauty Co';
  return (
    <section className={`wa-phone ${className ?? ''}`} aria-label={`Chat with ${name}`}>
      <header className="wa-bar">
        {onClose && (
          <button type="button" className="wa-bar__back" aria-label="Close chat" onClick={onClose}>
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        )}
        {brand?.logo_url ? (
          <img className="wa-avatar" src={brand.logo_url} alt="" />
        ) : (
          <span className="wa-avatar wa-avatar--initials" aria-hidden="true">
            {name.slice(0, 2).toUpperCase()}
          </span>
        )}
        <div className="wa-bar__who">
          <strong>{name}</strong>
          <span>usually replies instantly</span>
        </div>
      </header>
      <ChatThread
        messages={messages.map(asChat)}
        mode="customer"
        busy={busy}
        onChoose={(o: ChatOption) => void send({ type: 'INTERACTIVE_REPLY', option_id: o.option_id })}
        empty={`Say hello to ${name}. Ask about a product, or share your location to find a store that has it today.`}
      />
      {error && (
        <p className="wa-error" role="alert">
          {error}
        </p>
      )}
      <ChatComposer draft={draft} onDraftChange={setDraft} onSend={(c) => void send(c)} disabled={busy} />
    </section>
  );
}
