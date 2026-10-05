import { CheckCheck, List, MapPin, X } from 'lucide-react';
import { useState } from 'react';
import type { ChatMessage, ChatOption } from '../../pages/brand/conversationTypes';
import { mapsUrl, WhatsAppText } from './format';

export type ChatMode = 'customer' | 'brand';

/** Internal labels — brand view only; the shopper never sees them. */
const ORIGIN_LABEL: Record<string, string> = {
  CUSTOMER: 'Customer',
  AUTOMATED_REPLY: 'AI assistant',
  PROACTIVE_FOLLOW_UP: 'Follow-up',
  RESERVATION_UPDATE: 'Store update',
  HUMAN_AGENT: 'Team member',
};

export function originLabel(m: Pick<ChatMessage, 'origin' | 'message_kind'>): string {
  const base = ORIGIN_LABEL[m.origin] ?? 'Message';
  if (m.origin === 'PROACTIVE_FOLLOW_UP') return `${base} · ${m.message_kind === 'TEMPLATE' ? 'Template' : 'Session'}`;
  return base;
}

const time = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** Buttons (≤ 3 short choices) or a list (anything else) — the same rule as the backend. */
export function isList(options: ChatOption[]): boolean {
  return options.length > 3 || options.some((o) => o.label.length > 20 || !!o.description || !!o.section);
}

/**
 * One message, rendered only with parts real WhatsApp has: image header, body text with
 * WhatsApp formatting, footer, reply buttons, a list (opened as a sheet), a location
 * message and a CTA button. `customer` mode is the shopper's phone; `brand` mode adds the
 * internal label and the delivery status for the Brand Console.
 */
export function ChatBubble({
  message: m,
  mode,
  onChoose,
  choicesEnabled = false,
}: {
  message: ChatMessage;
  mode: ChatMode;
  onChoose?: (option: ChatOption) => void;
  choicesEnabled?: boolean;
}) {
  const [sheet, setSheet] = useState(false);
  const outbound = m.direction === 'OUTBOUND';
  const parts = m.parts ?? null;
  const options = m.options ?? [];
  const list = options.length > 0 && isList(options);
  const choose = (o: ChatOption) => {
    setSheet(false);
    onChoose?.(o);
  };
  const sections = [...new Set(options.map((o) => o.section ?? ''))];

  return (
    <div className={`wa-msg ${outbound ? 'wa-msg--in' : 'wa-msg--out'}`}>
      {mode === 'brand' && <div className="wa-label">{originLabel(m)}</div>}
      <div className="wa-bubble">
        {parts?.header?.type === 'IMAGE' && (
          <img className="wa-header-image" src={parts.header.url} alt={parts.header.alt} loading="lazy" />
        )}
        {parts?.header?.type === 'TEXT' && <div className="wa-header-text">{parts.header.text}</div>}
        {m.text && (
          <div className="wa-text">
            <WhatsAppText text={m.text} />
          </div>
        )}
        {!m.text && m.location && (
          <div className="wa-text">
            📍 Location shared ({m.location.latitude.toFixed(2)}, {m.location.longitude.toFixed(2)})
          </div>
        )}
        {parts?.footer && <div className="wa-footer">{parts.footer}</div>}
        <div className="wa-meta">
          {time(m.timestamp)}
          {!outbound && <CheckCheck size={14} aria-hidden="true" className="wa-ticks" />}
          {mode === 'brand' && outbound && m.delivery_status === 'FAILED' && (
            <span className="wa-failed"> · Not delivered</span>
          )}
        </div>
      </div>

      {parts?.location && (
        <a
          className="wa-location"
          href={mapsUrl(parts.location.latitude, parts.location.longitude)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="wa-location__map" aria-hidden="true">
            <MapPin size={22} />
          </span>
          <span className="wa-location__text">
            <strong>{parts.location.name}</strong>
            <span>{parts.location.address}</span>
            <span className="wa-location__open">Open in Maps</span>
          </span>
        </a>
      )}

      {parts?.cta_url && (
        <a className="wa-choice" href={parts.cta_url.url} target="_blank" rel="noopener noreferrer">
          {parts.cta_url.label}
        </a>
      )}

      {options.length > 0 && !list && (
        <div className="wa-choices" role="group" aria-label="Reply buttons">
          {options.map((o) => (
            <button
              key={o.option_id}
              type="button"
              className="wa-choice"
              disabled={!choicesEnabled}
              onClick={() => choose(o)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {list && (
        <>
          <button
            type="button"
            className="wa-choice"
            disabled={!choicesEnabled && mode === 'customer'}
            onClick={() => setSheet(true)}
          >
            <List size={16} aria-hidden="true" /> {parts?.list_button ?? 'Choose an option'}
          </button>
          {sheet && (
            <div className="wa-sheet-overlay" onClick={() => setSheet(false)}>
              <div
                className="wa-sheet"
                role="dialog"
                aria-modal="true"
                aria-label={parts?.list_button ?? 'Choose an option'}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="wa-sheet__head">
                  <strong>{parts?.list_button ?? 'Choose an option'}</strong>
                  <button type="button" className="ui-icon-button" aria-label="Close" onClick={() => setSheet(false)}>
                    <X size={18} aria-hidden="true" />
                  </button>
                </div>
                {sections.map((section) => (
                  <div key={section} className="wa-sheet__section">
                    {section && <div className="wa-sheet__title">{section}</div>}
                    {options
                      .filter((o) => (o.section ?? '') === section)
                      .map((o) => (
                        <button
                          key={o.option_id}
                          type="button"
                          className="wa-row"
                          disabled={!choicesEnabled}
                          onClick={() => choose(o)}
                        >
                          <strong>{o.label}</strong>
                          {o.description && <span>{o.description}</span>}
                        </button>
                      ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
