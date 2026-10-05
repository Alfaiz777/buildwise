import { useState, type FormEvent } from 'react';
import { WAITING_CHANGED } from '../../components/shell/AppShell';
import { useApi } from '../../api/apiContext';
import { errorMessage } from '../../components/ConsoleShell';

/** "waiting 12 min" since the customer asked for a person. */
export function waitingFor(handoffAt: string | null | undefined, now: number): string | null {
  if (!handoffAt) return null;
  const min = Math.max(0, Math.floor((now - new Date(handoffAt).getTime()) / 60_000));
  return min >= 60 ? `waiting ${Math.floor(min / 60)} h ${min % 60} min` : `waiting ${min} min`;
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
