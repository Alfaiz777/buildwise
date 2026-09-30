/**
 * Deterministic, per-brand follow-up policy (docs/00 §11.8 Change 11, D5;
 * docs/04_DATA_MODEL.md §3, §11.3). Pure: the same function decides at scheduling time
 * and again at send time.
 */
import type { IntentStrength, IntentType } from './ai.js';
import type { Channel } from './channels.js';

export type FollowUpReason =
  | 'ALREADY_CONVERTED'
  | 'ALREADY_FOLLOWED_UP'
  | 'WEAK_INTENT'
  | 'INTENT_TYPE_DISABLED'
  | 'CUSTOMER_NOT_REACHABLE'
  | 'CHANNEL_DISABLED'
  | 'OPTED_OUT'
  | 'NO_CONSENT'
  | 'HUMAN_HANDOFF'
  | 'CUSTOMER_ALREADY_IN_CONVERSATION'
  | 'FREQUENCY_LIMIT';

export type FollowUpStatus =
  'NOT_ELIGIBLE' | 'SCHEDULED' | 'SUPPRESSED' | 'SENT' | 'REPLIED' | 'CONVERTED' | 'HANDOFF' | 'OPTED_OUT';

export type FollowUpPriority = 'NORMAL' | 'HIGH';

/** Types that can ever get a follow-up; VISIT_ONLY and PRODUCT_EXPLORATION never do. */
export const FOLLOW_UP_TYPES = [
  'SEARCH_EXPLORATION',
  'PRODUCT_CONSIDERATION',
  'CART_ABANDONMENT',
  'CHECKOUT_ABANDONMENT',
  'STORE_ORIENTED',
] as const;
export type FollowUpType = (typeof FOLLOW_UP_TYPES)[number];

export interface FollowUpTypePolicy {
  enabled: boolean;
  delayMinutes: number;
  priority: FollowUpPriority;
}

export interface FollowUpSettings {
  inactivityMinutes: number;
  frequencyHours: number;
  types: Record<FollowUpType, FollowUpTypePolicy>;
}

export const DEFAULT_FOLLOW_UP_SETTINGS: FollowUpSettings = {
  inactivityMinutes: 30,
  frequencyHours: 24,
  types: {
    SEARCH_EXPLORATION: { enabled: false, delayMinutes: 60, priority: 'NORMAL' },
    PRODUCT_CONSIDERATION: { enabled: true, delayMinutes: 60, priority: 'NORMAL' },
    CART_ABANDONMENT: { enabled: true, delayMinutes: 60, priority: 'NORMAL' },
    CHECKOUT_ABANDONMENT: { enabled: true, delayMinutes: 30, priority: 'HIGH' },
    STORE_ORIENTED: { enabled: true, delayMinutes: 10, priority: 'NORMAL' },
  },
};

/** Reads brand.settings.follow_up_policy (snake_case) over the defaults; bad values are ignored. */
export function resolveFollowUpSettings(raw: unknown): FollowUpSettings {
  const src = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
  const rawTypes = (src.types ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const types = Object.fromEntries(
    FOLLOW_UP_TYPES.map((t) => {
      const d = DEFAULT_FOLLOW_UP_SETTINGS.types[t];
      const r = rawTypes[t] ?? {};
      return [
        t,
        {
          enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
          delayMinutes: num(r.delay_minutes, d.delayMinutes),
          priority: r.priority === 'HIGH' || r.priority === 'NORMAL' ? r.priority : d.priority,
        },
      ];
    }),
  ) as Record<FollowUpType, FollowUpTypePolicy>;
  return {
    inactivityMinutes: num(src.inactivity_minutes, DEFAULT_FOLLOW_UP_SETTINGS.inactivityMinutes),
    frequencyHours: num(src.frequency_hours, DEFAULT_FOLLOW_UP_SETTINGS.frequencyHours),
    types,
  };
}

export interface FollowUpIntentView {
  type: IntentType;
  strength: IntentStrength;
  status: 'ACTIVE' | 'ABANDONED' | 'CONVERTED' | 'EXPIRED';
  matchedCategory: string | null;
  detectedAt: string;
  lastEventAt: string;
  /** Set when the intent's WhatsApp token was consumed (the customer messaged us). */
  tokenConsumedAt: string | null;
  followUpStatus: FollowUpStatus | null;
}

export interface FollowUpCustomerView {
  channel: Channel | null;
  consentState: string;
  lastProactiveAt: string | null;
}

export interface FollowUpConversationView {
  humanHandoff: boolean;
  lastInboundAt: string | null;
}

export type FollowUpDecision =
  | { decision: 'FOLLOW_UP_ELIGIBLE'; reason: 'ELIGIBLE'; dueAt: string; priority: FollowUpPriority }
  | { decision: 'FOLLOW_UP_NOT_ELIGIBLE'; reason: FollowUpReason };

const notEligible = (reason: FollowUpReason): FollowUpDecision => ({ decision: 'FOLLOW_UP_NOT_ELIGIBLE', reason });
const isFollowUpType = (t: IntentType): t is FollowUpType => (FOLLOW_UP_TYPES as readonly string[]).includes(t);
const addMinutes = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

/**
 * Reasons are checked in a fixed order: facts about the intent first, then about the
 * customer (docs/00 §11.8 Change 11, D5).
 */
export function evaluateFollowUp(input: {
  intent: FollowUpIntentView;
  customer: FollowUpCustomerView | null;
  conversation: FollowUpConversationView | null;
  enabledChannels: readonly Channel[];
  settings: FollowUpSettings;
  now: Date;
}): FollowUpDecision {
  const { intent, customer, conversation, settings, now } = input;

  if (intent.status === 'CONVERTED' || intent.followUpStatus === 'CONVERTED') return notEligible('ALREADY_CONVERTED');
  if (intent.followUpStatus && ['SENT', 'REPLIED', 'HANDOFF', 'OPTED_OUT'].includes(intent.followUpStatus)) {
    return notEligible('ALREADY_FOLLOWED_UP');
  }
  if (!isFollowUpType(intent.type)) return notEligible('WEAK_INTENT');
  if (intent.type === 'SEARCH_EXPLORATION' && !intent.matchedCategory) return notEligible('WEAK_INTENT');
  if (intent.strength === 'NO_MEANINGFUL_INTENT' && intent.type !== 'SEARCH_EXPLORATION') {
    return notEligible('WEAK_INTENT');
  }
  const policy = settings.types[intent.type];
  if (!policy.enabled) return notEligible('INTENT_TYPE_DISABLED');

  if (!customer || !customer.channel) return notEligible('CUSTOMER_NOT_REACHABLE');
  if (!input.enabledChannels.includes(customer.channel)) return notEligible('CHANNEL_DISABLED');
  if (customer.consentState === 'OPTED_OUT') return notEligible('OPTED_OUT');
  if (customer.consentState !== 'OPTED_IN') return notEligible('NO_CONSENT');
  if (conversation?.humanHandoff) return notEligible('HUMAN_HANDOFF');
  if (intent.tokenConsumedAt || (conversation?.lastInboundAt && conversation.lastInboundAt >= intent.detectedAt)) {
    return notEligible('CUSTOMER_ALREADY_IN_CONVERSATION');
  }
  if (
    customer.lastProactiveAt &&
    now.getTime() - new Date(customer.lastProactiveAt).getTime() < settings.frequencyHours * 3_600_000
  ) {
    return notEligible('FREQUENCY_LIMIT');
  }

  return {
    decision: 'FOLLOW_UP_ELIGIBLE',
    reason: 'ELIGIBLE',
    dueAt: addMinutes(intent.lastEventAt, policy.delayMinutes),
    priority: policy.priority,
  };
}

/** An ACTIVE intent with no activity for the inactivity threshold is abandoned. */
export function isInactive(lastEventAt: string, settings: FollowUpSettings, now: Date): boolean {
  return now.getTime() - new Date(lastEventAt).getTime() >= settings.inactivityMinutes * 60_000;
}
