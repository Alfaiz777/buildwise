/**
 * Outcome rules (docs/04 §16, §16.1; docs/00 §11.8 Change 13, F5). Pure. An Outcome is
 * one per engaged journey, decided from verified evidence only; the first verified
 * purchase wins and NONE is decided only after the attribution window.
 */
import type { AiAction } from './ai.js';

export const PURCHASE_TYPES = ['ONLINE', 'OFFLINE', 'ALTERNATIVE', 'NONE'] as const;
export type PurchaseType = (typeof PURCHASE_TYPES)[number];

/** int:<intent_id> when the decision was made for a bound intent, else conv:<conversation_id>. */
export const journeyKeyFor = (r: { intentId: string | null; conversationId: string }) =>
  r.intentId ? `int:${r.intentId}` : `conv:${r.conversationId}`;

export const parseJourneyKey = (key: string) =>
  key.startsWith('int:')
    ? { intentId: key.slice(4), conversationId: null }
    : { intentId: null, conversationId: key.startsWith('conv:') ? key.slice(5) : null };

/** OFFLINE / ONLINE, or ALTERNATIVE when the purchased variant differs from the journey's variant. */
export function purchaseTypeFor(
  channel: 'STORE' | 'ONLINE',
  journeyVariantId: string | null,
  purchasedVariantId: string | null,
): PurchaseType {
  if (journeyVariantId && purchasedVariantId && journeyVariantId !== purchasedVariantId) return 'ALTERNATIVE';
  return channel === 'STORE' ? 'OFFLINE' : 'ONLINE';
}

export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 7;

/** brand.settings.outcome_policy: attribution_window_minutes (local demo) or _days (default 7). */
export function attributionWindowMs(settings: Record<string, unknown>): number {
  const raw = settings.outcome_policy;
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const minutes = p.attribution_window_minutes;
  if (typeof minutes === 'number' && minutes > 0 && minutes <= 60 * 24 * 90) return minutes * 60_000;
  const days = p.attribution_window_days;
  const d = typeof days === 'number' && days > 0 && days <= 90 ? days : DEFAULT_ATTRIBUTION_WINDOW_DAYS;
  return d * 24 * 60 * 60_000;
}

/**
 * NONE is due only when the window has passed since the journey's last activity
 * (its last recommendation or proactive message) and no reservation is still active —
 * a held product may still be collected, and the customer may still buy online.
 */
export function isJourneyClosed(input: {
  lastActivityAt: string;
  windowMs: number;
  now: Date;
  hasActiveReservation: boolean;
}): boolean {
  if (input.hasActiveReservation) return false;
  return input.now.getTime() >= new Date(input.lastActivityAt).getTime() + input.windowMs;
}

/** docs/04 §16.1: the purchase type(s) each action aims for (null = no intended purchase). */
export const INTENDED_PURCHASE: Record<AiAction, readonly PurchaseType[] | null> = {
  NO_ACTION: null,
  EDUCATE: ['ONLINE', 'OFFLINE'],
  COMPARE: ['ONLINE', 'OFFLINE'],
  ONLINE_PURCHASE: ['ONLINE'],
  STORE_DISCOVERY: ['OFFLINE'],
  STORE_RESERVATION: ['OFFLINE'],
  ALTERNATIVE_PRODUCT: ['ALTERNATIVE'],
  HUMAN_HANDOFF: null,
};

/** "Converted": the recorded purchase type is one the action aimed for. */
export const converted = (action: AiAction, recorded: PurchaseType) =>
  INTENDED_PURCHASE[action]?.includes(recorded) ?? false;
