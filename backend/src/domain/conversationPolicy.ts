/**
 * Conversation policy (docs/03 §8.2 step 5, docs/07_SECURITY_SPEC.md §10, §17).
 * Pure rules shared by the inbound pipeline and the proactive follow-up path, so both
 * obey the same consent / opt-out / window / handoff rules on every channel.
 */

export const MAX_INBOUND_TEXT = 2000;
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AI_DECISIONS_PER_WINDOW = 10;
export const AI_WINDOW_MS = 5 * 60 * 1000;

/** STOP / UNSUBSCRIBE as the whole message (case- and punctuation-insensitive). */
export function isOptOutRequest(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z ]/g, '');
  return ['stop', 'unsubscribe', 'stop all', 'opt out', 'optout'].includes(normalized);
}

/** An explicit request to talk to a person. */
export function isHumanRequest(text: string): boolean {
  return /\b(human|person|agent|someone|representative|real people|talk to (a|an|the)? ?(team|staff))\b/i.test(text);
}

export function truncateInbound(text: string): string {
  return text.length > MAX_INBOUND_TEXT ? text.slice(0, MAX_INBOUND_TEXT) : text;
}

/** Inside the customer-service window: the customer messaged within the last 24 h. */
export function inServiceWindow(lastInboundAt: string | null, now: Date): boolean {
  return !!lastInboundAt && now.getTime() - new Date(lastInboundAt).getTime() < SERVICE_WINDOW_MS;
}

/** SESSION (free text) inside the window, otherwise only an approved TEMPLATE (D6). */
export type MessageKind = 'SESSION' | 'TEMPLATE';
export const messageKindFor = (lastInboundAt: string | null, now: Date): MessageKind =>
  inServiceWindow(lastInboundAt, now) ? 'SESSION' : 'TEMPLATE';

export interface AiWindow {
  windowStart: string | null;
  count: number;
  noticeSent: boolean;
}

/**
 * Per-conversation AI decision limit (10 per 5 min). Beyond it, no decision is made and
 * at most one fixed "please wait" reply is sent per window.
 */
export function nextAiWindow(
  window: AiWindow,
  now: Date,
): { allowed: boolean; sendWaitNotice: boolean; next: AiWindow } {
  const start = window.windowStart ? new Date(window.windowStart).getTime() : 0;
  if (!window.windowStart || now.getTime() - start >= AI_WINDOW_MS) {
    return {
      allowed: true,
      sendWaitNotice: false,
      next: { windowStart: now.toISOString(), count: 1, noticeSent: false },
    };
  }
  if (window.count < AI_DECISIONS_PER_WINDOW) {
    return { allowed: true, sendWaitNotice: false, next: { ...window, count: window.count + 1 } };
  }
  return { allowed: false, sendWaitNotice: !window.noticeSent, next: { ...window, noticeSent: true } };
}

export type InboundPolicyDecision =
  | { reply: 'AUTOMATED' }
  | { reply: 'NONE'; reason: 'OPTED_OUT' | 'OPT_OUT_REQUEST' | 'HUMAN_HANDOFF' | 'AI_RATE_LIMITED' }
  | { reply: 'WAIT_NOTICE'; reason: 'AI_RATE_LIMITED' };

/** Whether an inbound message may get an automated reply. */
export function decideInboundPolicy(input: {
  text: string;
  consentState: string;
  humanHandoff: boolean;
  aiWindow: { allowed: boolean; sendWaitNotice: boolean };
}): InboundPolicyDecision {
  if (isOptOutRequest(input.text)) return { reply: 'NONE', reason: 'OPT_OUT_REQUEST' };
  if (input.consentState === 'OPTED_OUT') return { reply: 'NONE', reason: 'OPTED_OUT' };
  if (input.humanHandoff) return { reply: 'NONE', reason: 'HUMAN_HANDOFF' };
  if (!input.aiWindow.allowed) {
    return input.aiWindow.sendWaitNotice
      ? { reply: 'WAIT_NOTICE', reason: 'AI_RATE_LIMITED' }
      : { reply: 'NONE', reason: 'AI_RATE_LIMITED' };
  }
  return { reply: 'AUTOMATED' };
}
