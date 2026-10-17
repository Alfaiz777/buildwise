import { useEffect, useState, type FormEvent } from 'react';
import { WAITING_CHANGED } from '../../components/shell/AppShell';
import { useApi } from '../../api/apiContext';
import { errorMessage } from '../../components/ConsoleShell';
import { loadConversationSummary } from './AiCards';
import { AiLabel, type AssistantAnswer } from './askQwikspot';

/** "waiting 12 min" since the customer asked for a person. */
export function waitingFor(handoffAt: string | null | undefined, now: number): string | null {
  if (!handoffAt) return null;
  const min = Math.max(0, Math.floor((now - new Date(handoffAt).getTime()) / 60_000));
  return min >= 60 ? `waiting ${Math.floor(min / 60)} h ${min % 60} min` : `waiting ${min} min`;
}

/**
 * L9: the handoff brief for the person taking over — what the shopper wants and what was
 * already tried — with its "AI summary" / "Quick summary" label. It loads after the list (never
 * blocking it), from the conversation summary the backend keeps; it has no shopper name or
 * phone number (the backend redacts and checks them). Nothing is shown until it has loaded, or
 * if it fails.
 */
export function HandoffBrief({
  conversationId,
  cacheKey,
  compact = false,
}: {
  conversationId: string;
  /** The conversation's version (its last message time or message count): a new message reloads it. */
  cacheKey?: unknown;
  /** The inbox item's form: the label and the 2 lines, no heading. */
  compact?: boolean;
}) {
  const api = useApi();
  const [summary, setSummary] = useState<AssistantAnswer | null>(null);
  useEffect(() => {
    let live = true;
    setSummary(null);
    loadConversationSummary(api, conversationId, cacheKey)
      .then((s) => live && setSummary(s))
      .catch(() => undefined); // the inbox item stays as it is
    return () => {
      live = false;
    };
  }, [api, conversationId, cacheKey]);
  if (!summary?.handoff_brief) return null;
  return (
    <div className={`handoff-brief${compact ? ' handoff-brief--compact' : ''}`} aria-label="Handoff brief">
      <div className="handoff-brief__head">
        {!compact && <strong className="small">Handoff brief</strong>}
        <AiLabel source={summary.source} />
      </div>
      <p className="small">{summary.handoff_brief}</p>
    </div>
  );
}

/**
 * The handoff queue's reply box (docs/11 §4, Change 13 F7): a Brand Admin replies as a
 * person — the customer sees the brand, never the admin's identity — then returns the
 * conversation to the assistant. While a person owns it, no automated reply or follow-up
 * is sent.
 */
export function HandoffPanel(props: {
  conversationId: string;
  handoffAt: string | null | undefined;
  /** The conversation's version, so the brief follows new messages. */
  refreshKey?: unknown;
  onChanged: () => void;
}) {
  const api = useApi();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const waiting = waitingFor(props.handoffAt, Date.now());

  async function reply(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/brand/conversations/${props.conversationId}/replies`, { text: text.trim() });
      setText('');
      setNotice('Reply sent as the brand.');
      props.onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resolve() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/brand/conversations/${props.conversationId}/resolve`, {});
      window.dispatchEvent(new Event(WAITING_CHANGED));
      setNotice('Returned to the assistant: the next customer message gets an automated reply.');
      props.onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="handoff-panel" aria-label="Needs a person">
      <HandoffBrief conversationId={props.conversationId} cacheKey={props.refreshKey} />
      <h3>A person owns this conversation {waiting && <span className="badge warn">{waiting}</span>}</h3>
      <p className="muted small">
        Automated replies and follow-ups are paused. Opt-out and the 24-hour window still apply.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice small" role="status">
          {notice}
        </p>
      )}
      <form className="phone-input" onSubmit={reply}>
        <input
          aria-label="Reply as a person"
          placeholder="Reply to the customer as the brand"
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={busy || !text.trim()}>
          Send reply
        </button>
      </form>
      <button type="button" className="secondary" disabled={busy} onClick={() => void resolve()}>
        Resolve and return to assistant
      </button>
    </div>
  );
}
