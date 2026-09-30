/**
 * Deterministic storefront intent classification (docs/04_DATA_MODEL.md §11.1–§11.2,
 * docs/00 §11.8 Change 11, D2–D4). Pure: the AI never sets stage or strength.
 *
 *   stage     = how far the customer progressed (monotonic within a web session)
 *   type      = what they are trying to do (the stage's type, or STORE_ORIENTED)
 *   strength  = derived from the stage + the WhatsApp-click signal
 */
import { INTENT_STAGES, type IntentStage, type IntentStrength, type IntentType } from './ai.js';

export const WEB_EVENT_TYPES = [
  'STOREFRONT_VISIT',
  'SEARCH',
  'PRODUCT_VIEW',
  'PRODUCT_DETAIL_VIEW',
  'VARIANT_SELECTED',
  'ADD_TO_CART',
  'CHECKOUT_STARTED',
  'WHATSAPP_CLICK',
] as const;
export type WebEventType = (typeof WEB_EVENT_TYPES)[number];

/** Events that must name a product variant. */
export const PRODUCT_EVENTS: readonly WebEventType[] = [
  'PRODUCT_VIEW',
  'PRODUCT_DETAIL_VIEW',
  'VARIANT_SELECTED',
  'ADD_TO_CART',
  'CHECKOUT_STARTED',
];

export type WhatsAppEntry = 'STORE_NEED' | 'CHAT';

export interface WebEvent {
  type: WebEventType;
  productId: string | null;
  variantId: string | null;
  /** Catalogue category/tag a SEARCH matched (never the raw term). */
  matchedCategory: string | null;
  entry: WhatsAppEntry | null;
  /** Server receive time (ISO-8601): client clocks are not trusted. */
  at: string;
}

export interface IntentSignals {
  productViews: Record<string, number>;
  detailViews: Record<string, number>;
  variantSelected: string[];
  whatsappClicks: number;
  storeNeedClickedAt: string | null;
  chatClickedAt: string | null;
}

export interface IntentClassification {
  stage: IntentStage;
  strength: IntentStrength;
  type: IntentType;
  productId: string | null;
  variantId: string | null;
  matchedCategory: string | null;
  signals: IntentSignals;
  lastEvent: WebEventType;
  lastEventAt: string;
  eventCount: number;
}

const STAGE_TYPE: Record<IntentStage, IntentType> = {
  VISIT: 'VISIT_ONLY',
  SEARCH: 'SEARCH_EXPLORATION',
  PRODUCT_VIEW: 'PRODUCT_EXPLORATION',
  CONSIDERATION: 'PRODUCT_CONSIDERATION',
  CART: 'CART_ABANDONMENT',
  CHECKOUT: 'CHECKOUT_ABANDONMENT',
};

export const stageRank = (stage: IntentStage) => INTENT_STAGES.indexOf(stage);
const maxStage = (a: IntentStage | null, b: IntentStage | null): IntentStage =>
  a === null ? b! : b === null || stageRank(a) >= stageRank(b) ? a : b;

const EMPTY_SIGNALS: IntentSignals = {
  productViews: {},
  detailViews: {},
  variantSelected: [],
  whatsappClicks: 0,
  storeNeedClickedAt: null,
  chatClickedAt: null,
};

/** The stage a single event reaches, given the signals that include it. */
function stageOf(event: WebEvent, signals: IntentSignals): IntentStage | null {
  switch (event.type) {
    case 'STOREFRONT_VISIT':
      return 'VISIT';
    case 'SEARCH':
      return 'SEARCH';
    case 'PRODUCT_VIEW':
      return 'PRODUCT_VIEW';
    case 'PRODUCT_DETAIL_VIEW':
      return (signals.detailViews[event.productId!] ?? 0) >= 2 ? 'CONSIDERATION' : 'PRODUCT_VIEW';
    case 'VARIANT_SELECTED':
      return 'CONSIDERATION';
    case 'ADD_TO_CART':
      return 'CART';
    case 'CHECKOUT_STARTED':
      return 'CHECKOUT';
    case 'WHATSAPP_CLICK':
      return null; // changes the type (store need), never the stage
  }
}

export function deriveStrength(stage: IntentStage, signals: IntentSignals): IntentStrength {
  if (stageRank(stage) >= stageRank('CART') || signals.whatsappClicks > 0) return 'HIGH_INTENT';
  const detailed = Object.values(signals.detailViews).some((n) => n > 0);
  const repeatedView = Object.values(signals.productViews).some((n) => n >= 2);
  if (stage === 'CONSIDERATION' || detailed || repeatedView) return 'INTERESTED';
  return 'NO_MEANINGFUL_INTENT';
}

/** Applies one web event to the session's intent (null = first event of the session). */
export function applyWebEvent(current: IntentClassification | null, event: WebEvent): IntentClassification {
  const prev = current?.signals ?? EMPTY_SIGNALS;
  const signals: IntentSignals = {
    productViews: { ...prev.productViews },
    detailViews: { ...prev.detailViews },
    variantSelected: [...prev.variantSelected],
    whatsappClicks: prev.whatsappClicks,
    storeNeedClickedAt: prev.storeNeedClickedAt,
    chatClickedAt: prev.chatClickedAt,
  };
  const pid = event.productId;
  if (event.type === 'PRODUCT_VIEW' && pid) signals.productViews[pid] = (signals.productViews[pid] ?? 0) + 1;
  if (event.type === 'PRODUCT_DETAIL_VIEW' && pid) signals.detailViews[pid] = (signals.detailViews[pid] ?? 0) + 1;
  if (event.type === 'VARIANT_SELECTED' && pid && !signals.variantSelected.includes(pid)) {
    signals.variantSelected.push(pid);
  }
  if (event.type === 'WHATSAPP_CLICK') {
    signals.whatsappClicks += 1;
    if (event.entry === 'STORE_NEED') signals.storeNeedClickedAt = event.at;
    else signals.chatClickedAt = event.at;
  }

  // A first-ever WhatsApp click with no browsing still needs a stage: the lowest one.
  const stage = maxStage(current?.stage ?? null, stageOf(event, signals) ?? (current ? null : 'VISIT'));
  const type: IntentType = signals.storeNeedClickedAt ? 'STORE_ORIENTED' : STAGE_TYPE[stage];

  return {
    stage,
    strength: deriveStrength(stage, signals),
    type,
    productId: pid ?? current?.productId ?? null,
    variantId: event.variantId ?? current?.variantId ?? null,
    matchedCategory: event.type === 'SEARCH' ? event.matchedCategory : (current?.matchedCategory ?? null),
    signals,
    lastEvent: event.type,
    lastEventAt: event.at,
    eventCount: (current?.eventCount ?? 0) + 1,
  };
}

/** Normalizes a storefront search term: trimmed, lower-cased, collapsed spaces, ≤ 80 chars. */
export function normalizeSearchTerm(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

/** Search terms must not carry PII: an email address or a phone-like digit run is rejected. */
export function looksLikePii(term: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(term) || /(?:\d[\s-]?){7,}/.test(term);
}

/**
 * Matches a normalized search term against catalogue categories and tags. Returns the
 * catalogue's own label (never the customer's words), or null when nothing matched.
 */
export function matchSearchCategory(term: string, catalogue: { categories: string[]; tags: string[] }): string | null {
  const words = new Set(term.split(/[^a-z0-9]+/).filter(Boolean));
  const hit = (label: string) => {
    const parts = label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return parts.length > 0 && parts.every((p) => words.has(p) || words.has(`${p}s`) || words.has(p.replace(/s$/, '')));
  };
  return catalogue.categories.find(hit) ?? catalogue.tags.find(hit) ?? null;
}
