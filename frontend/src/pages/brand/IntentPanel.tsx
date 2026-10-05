import { useEffect, useState } from 'react';
import { outcomeText } from './journey';
import { formatDateTime } from './types';
import {
  countdown,
  EVENT_TEXT,
  humanize,
  REASON_TEXT,
  type ConversationDetail,
  type IntentSummary,
} from './conversationTypes';

/** Ticks once a second so the due-time countdown is live. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * "Intent & follow-up": answers, in plain words, what the customer did, what Qwikspot
 * detected, whether a follow-up was eligible and why, when it was due, what was sent,
 * and what happened next. It grows into the decision trace in M5.
 */
export function IntentPanel({
  intent,
  events,
  conversation,
}: {
  intent: IntentSummary | null;
  events: ConversationDetail['web_events'];
  conversation: Pick<ConversationDetail, 'human_handoff' | 'messages' | 'outcomes'> | null;
}) {
  const now = useNow();
  if (!intent) {
    return (
      <div className="intent-panel">
        <h3>Intent & follow-up</h3>
        <p className="muted small">
          No storefront intent is linked to this conversation. It started in the chat, not from the website.
        </p>
      </div>
    );
  }
  const f = intent.follow_up;
  // A store pickup is an in-store purchase (OFFLINE outcome), not an online order.
  const purchase = conversation?.outcomes?.find((o) => o.purchase_type !== 'NONE') ?? null;
  const replied = conversation?.messages.some((m) => m.origin === 'CUSTOMER' && f?.sent_at && m.timestamp > f.sent_at);

  return (
    <div className="intent-panel" aria-label="Intent and follow-up">
      <h3>Intent & follow-up</h3>

      <h4>What did the customer do?</h4>
      {events.length === 0 ? (
        <p className="muted small">No storefront events recorded.</p>
      ) : (
        <ol className="events">
          {events.map((e, i) => (
            <li key={`${e.event_type}-${i}`}>
              <span>{EVENT_TEXT[e.event_type] ?? humanize(e.event_type)}</span>
              {e.details.matched_category && (
                <span className="muted small"> · {String(e.details.matched_category)}</span>
              )}
              {e.details.entry && <span className="muted small"> · {humanize(String(e.details.entry))}</span>}
              <span className="muted small"> · {formatDateTime(e.at)}</span>
            </li>
          ))}
        </ol>
      )}

      <h4>What intent did Qwikspot detect?</h4>
      <p>
        <span className="badge">{humanize(intent.intent_type)}</span>{' '}
        <span className="badge">stage: {humanize(intent.intent_stage)}</span>{' '}
        <span className="badge">{humanize(intent.intent_strength)}</span>
      </p>
      <p className="small">
        {intent.product_title ? (
          <>
            Product: {intent.product_title}
            {intent.variant_title && ` (${intent.variant_title})`}
          </>
        ) : intent.matched_category ? (
          <>Category: {intent.matched_category}</>
        ) : (
          <span className="muted">No product yet.</span>
        )}{' '}
        · Session {humanize(intent.status)}
      </p>

      <h4>Was a follow-up eligible?</h4>
      {!f ? (
        <p className="muted small">Not evaluated yet.</p>
      ) : (
        <>
          <p className="small">
            <strong>{f.decision === 'FOLLOW_UP_ELIGIBLE' ? 'Yes.' : 'No.'}</strong>{' '}
            {REASON_TEXT[f.reason] ?? humanize(f.reason)} <span className="badge">{humanize(f.status)}</span>
            {f.priority === 'HIGH' && <span className="badge">high priority</span>}
          </p>
          {f.due_at && (
            <p className="small">
              Due: {formatDateTime(f.due_at)}
              {f.status === 'SCHEDULED' && <strong> ({countdown(f.due_at, now)})</strong>}
            </p>
          )}
          {f.sent_at && (
            <p className="small">
              Sent {formatDateTime(f.sent_at)} as a{' '}
              {f.message_kind === 'TEMPLATE' ? `template message (${f.template_name})` : 'session message'}.
            </p>
          )}
        </>
      )}

      <h4>What happened next?</h4>
      <ul className="small outcomes">
        <li>Replied: {replied || f?.status === 'REPLIED' ? 'yes' : 'no'}</li>
        <li>Asked for a person: {conversation?.human_handoff || f?.status === 'HANDOFF' ? 'yes' : 'no'}</li>
        <li>Opted out: {f?.status === 'OPTED_OUT' ? 'yes' : 'no'}</li>
        <li>
          Bought:{' '}
          {purchase ? outcomeText(purchase).title : intent.status === 'CONVERTED' ? 'ordered online' : 'not yet'}
        </li>
      </ul>
    </div>
  );
}
