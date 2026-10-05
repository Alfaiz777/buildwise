/**
 * Channel decoration of an automated reply (Change 16, UI-2): resolves relative media to
 * the public web origin and adds the "Powered by Qwikspot" footer where it belongs.
 *
 * The footer appears ONLY on interactive messages written by automation (the AI assistant,
 * follow-ups, store updates) and only when the brand has not switched it off
 * (`settings.messaging.powered_by_footer`). Never on a team member's reply, never on plain
 * text, never in the body; the sender is always the brand.
 */
import type { MessageParts, OutboundOption } from '../ports/messaging.js';
import { isInteractive } from './whatsappLimits.js';

export const POWERED_BY_FOOTER = 'Powered by Qwikspot';

export type MessageAuthor = 'AUTOMATED_REPLY' | 'PROACTIVE_FOLLOW_UP' | 'RESERVATION_UPDATE' | 'HUMAN_AGENT';
const AUTOMATION: ReadonlySet<MessageAuthor> = new Set([
  'AUTOMATED_REPLY',
  'PROACTIVE_FOLLOW_UP',
  'RESERVATION_UPDATE',
]);

/** "/demo-products/x.png" → "https://host/demo-products/x.png"; absolute URLs unchanged. */
export function absoluteUrl(url: string, publicOrigin: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${publicOrigin.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

export function decorateParts(input: {
  options: OutboundOption[] | undefined;
  parts: MessageParts | undefined;
  author: MessageAuthor;
  poweredByFooter: boolean;
  publicOrigin: string;
}): MessageParts | undefined {
  const parts: MessageParts = { ...(input.parts ?? {}) };
  if (parts.header?.type === 'IMAGE')
    parts.header = { ...parts.header, url: absoluteUrl(parts.header.url, input.publicOrigin) };
  if (input.author === 'HUMAN_AGENT') delete parts.footer;
  else if (input.poweredByFooter && AUTOMATION.has(input.author) && isInteractive(input.options, parts)) {
    parts.footer = POWERED_BY_FOOTER;
  }
  return Object.keys(parts).length > 0 ? parts : undefined;
}
