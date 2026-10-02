import { useState, type FormEvent } from 'react';
import { formatDateTime } from './types';
import { humanize, type ChatMessage, type IntentSummary, type SimulatorResponse } from './conversationTypes';

const ORIGIN_LABEL: Record<string, string> = {
  CUSTOMER: 'Customer',
  AUTOMATED_REPLY: 'Automated reply',
  PROACTIVE_FOLLOW_UP: 'Proactive follow-up',
  RESERVATION_UPDATE: 'Store update',
  HUMAN_AGENT: 'Team member',
};

/** "Mock AI, deterministic" for a MOCK agent decision; "Fallback" for the deterministic fallback. */
export function runtimeBadge(decision: SimulatorResponse['decision'] | null): string {
  if (!decision) return 'Mock AI, deterministic';
  if (decision.decision_source === 'DETERMINISTIC_FALLBACK') return 'Fallback (deterministic)';
  return decision.runtime === 'MOCK' ? 'Mock AI, deterministic' : 'Gemini';
}

/** Renders http(s) links in a message as links (e.g. the maps link and "Buy online"). */
function linkify(text: string) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

export interface SimulatorSend {
  customerRef: string;
  content:
    | { type: 'TEXT'; text: string }
    | { type: 'LOCATION'; latitude: number; longitude: number }
    | { type: 'INTERACTIVE_REPLY'; option_id: string };
}

/** Demo locations in Mumbai (synthetic). Near Powai: Powai has no stock, so Andheri is offered. */
const LOCATION_PRESETS = [
  { name: 'Near Powai', latitude: 19.12, longitude: 72.9 },
  { name: 'Near Bandra', latitude: 19.06, longitude: 72.83 },
];

/**
 * The simulator, styled as a phone chat (docs/11 §6): messages come from the brand, not
 * from "Buildwise". It always shows the Simulator and runtime badges, and labels each
 * message by origin (customer / automated reply / proactive follow-up with its kind).
 */
export function SimulatorPhone(props: {
  brandName: string;
  customerRef: string;
  onCustomerRefChange: (ref: string) => void;
  draft: string;
  onDraftChange: (text: string) => void;
  messages: ChatMessage[];
  intent: IntentSummary | null;
  lastDecision: SimulatorResponse['decision'] | null;
  busy: boolean;
  onSend: (send: SimulatorSend) => void;
}) {
  const [showLocation, setShowLocation] = useState(false);
  const [lat, setLat] = useState('19.12');
  const [lng, setLng] = useState('72.90');
  const lastOptions = [...props.messages].reverse().find((m) => m.direction === 'OUTBOUND')?.options ?? null;

  const sendText = (e: FormEvent) => {
    e.preventDefault();
    const text = props.draft.trim();
    if (!text) return;
    props.onSend({ customerRef: props.customerRef, content: { type: 'TEXT', text } });
  };

  return (
    <div className="phone" aria-label="Simulator">
      <div className="phone-header">
        <strong>{props.brandName}</strong>
        <div className="small">WhatsApp (simulated)</div>
        <div className="badges">
          <span className="badge">Simulator</span>
          <span className="badge">{runtimeBadge(props.lastDecision)}</span>
          {props.intent && <span className="badge">{humanize(props.intent.intent_type)}</span>}
          {props.intent && <span className="badge">stage: {humanize(props.intent.intent_stage)}</span>}
          {props.intent?.follow_up && (
            <span className="badge">follow-up: {humanize(props.intent.follow_up.status)}</span>
          )}
        </div>
      </div>

      <label className="small phone-ref">
        Customer ref
        <input
          aria-label="Simulator customer"
          value={props.customerRef}
          onChange={(e) => props.onCustomerRefChange(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
        />
      </label>

      <div className="phone-messages" role="log">
        {props.messages.length === 0 && <p className="muted small">No messages yet. Say hello as the customer.</p>}
        {props.messages.map((m) => (
          <div
            key={m.message_id}
            className={`bubble ${m.direction === 'INBOUND' ? 'in' : 'out'} ${m.origin.toLowerCase()}`}
          >
            <div className="bubble-label small">
              {ORIGIN_LABEL[m.origin]}
              {m.message_kind === 'TEMPLATE' && ' · Template'}
              {m.message_kind === 'SESSION' && m.origin === 'PROACTIVE_FOLLOW_UP' && ' · Session message'}
            </div>
            {m.text && <div className="bubble-text">{linkify(m.text)}</div>}
            {m.location && (
              <div className="bubble-text">
                📍 Location {m.location.latitude.toFixed(2)}, {m.location.longitude.toFixed(2)}
              </div>
            )}
            <div className="bubble-time small">
              {formatDateTime(m.timestamp)}
              {m.direction === 'OUTBOUND' && m.delivery_status === 'FAILED' && (
                <span className="delivery-failed"> · Not delivered</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {lastOptions && lastOptions.length > 0 && (
        <div className="phone-options">
          {lastOptions.map((o) => (
            <button
              key={o.option_id}
              type="button"
              className="secondary"
              disabled={props.busy}
              onClick={() =>
                props.onSend({
                  customerRef: props.customerRef,
                  content: { type: 'INTERACTIVE_REPLY', option_id: o.option_id },
                })
              }
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      <form className="phone-input" onSubmit={sendText}>
        <input
          aria-label="Message"
          placeholder="Type a message as the customer"
          value={props.draft}
          onChange={(e) => props.onDraftChange(e.target.value)}
        />
        <button type="submit" disabled={props.busy || !props.draft.trim()}>
          Send
        </button>
      </form>
      <button type="button" className="secondary small" onClick={() => setShowLocation((v) => !v)}>
        Share location
      </button>
      {showLocation && (
        <div className="phone-input">
          {LOCATION_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className="secondary small"
              onClick={() => {
                setLat(String(p.latitude));
                setLng(String(p.longitude));
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      {showLocation && (
        <div className="phone-input">
          <input aria-label="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} />
          <input aria-label="Longitude" value={lng} onChange={(e) => setLng(e.target.value)} />
          <button
            type="button"
            disabled={props.busy || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))}
            onClick={() =>
              props.onSend({
                customerRef: props.customerRef,
                content: { type: 'LOCATION', latitude: Number(lat), longitude: Number(lng) },
              })
            }
          >
            Send location
          </button>
        </div>
      )}
    </div>
  );
}
