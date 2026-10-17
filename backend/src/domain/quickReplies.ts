/**
 * Suggested replies after an answer (L9, docs/05 §19): 2–3 short choices under the agent's
 * answer to a product question or a store search, chosen by rules from the conversation state —
 * never free model text — so every choice is something the agent can act on. A tap is the
 * shopper's message: the choice's text, as if typed.
 *
 * On WhatsApp they are reply buttons (≤ 3, title ≤ 20 characters, inside the 24-hour window);
 * on the web chat, chips under the last message. None after a closing ("thanks", "bye"), a hold
 * confirmation or a handoff, and none where the turn already has its own buttons.
 *
 * The option id carries what the tap sends (`qr:<kind>:<lang>[:<product title>]`), so a tap
 * needs no lookup. The title is short ("Show stores near me", "Compare with Gel"); the text a
 * tap sends names the product in full ("Show stores near me for Mineral Sunscreen SPF 50",
 * "Compare with Ultra-Light Gel Sunscreen SPF 50"), so the agent knows which one.
 */
import type { AiAction } from './ai.js';
import type { Language, TurnType } from './conversationalReplies.js';
import type { InboundMessage, OutboundOption } from '../ports/messaging.js';
import { WHATSAPP_LIMITS } from './whatsappLimits.js';

export const QUICK_REPLY_PREFIX = 'qr:';
export const MAX_QUICK_REPLIES = 3;

export type QuickReplyKind = 'STORES' | 'COMPARE' | 'ONLINE' | 'AREA' | 'PERSON';
type Lang = 'en' | 'hi';

/** The button title (≤ 20 characters); COMPARE's names the alternative by one word. */
const TITLE: Record<QuickReplyKind, Record<Lang, (word?: string) => string>> = {
  // With a word: one of two compared products ("Stores for Gel").
  STORES: {
    en: (w) => (w ? `Stores for ${w}` : 'Show stores near me'),
    hi: (w) => (w ? `${w} ke store` : 'Paas ke store dikhao'),
  },
  COMPARE: { en: (w) => `Compare with ${w}`, hi: (w) => `${w} se compare` },
  ONLINE: { en: () => 'Buy online', hi: () => 'Online lena hai' },
  AREA: { en: () => 'Check another area', hi: () => 'Doosra area dekho' },
  PERSON: { en: () => 'Talk to a person', hi: () => 'Kisi se baat karao' },
};
/** The text a tap sends, naming the product when there is one. */
const TEXT: Record<QuickReplyKind, Record<Lang, (product?: string) => string>> = {
  STORES: {
    en: (p) => (p ? `Show stores near me for ${p}` : 'Show stores near me'),
    hi: (p) => (p ? `${p} paas mein kahan milega?` : 'Paas mein kahan milega?'),
  },
  COMPARE: { en: (p) => `Compare with ${p}`, hi: (p) => `${p} se compare karo` },
  ONLINE: {
    en: (p) => (p ? `I want to buy ${p} online` : 'Buy online'),
    hi: (p) => (p ? `${p} online lena hai` : 'Online lena hai'),
  },
  AREA: { en: () => 'Check another area', hi: () => 'Doosra area dekho' },
  PERSON: { en: () => 'Talk to a person', hi: () => 'Kisi se baat karao' },
};
/** Choices whose text names a product (the id carries its title). */
const NAMES_PRODUCT: readonly QuickReplyKind[] = ['STORES', 'COMPARE', 'ONLINE'];

/** Hinglish or Hindi conversations get the Hinglish choices. */
const langOf = (language: Language): Lang => (language === 'ENGLISH' ? 'en' : 'hi');

export const isQuickReply = (optionId: string) => optionId.startsWith(QUICK_REPLY_PREFIX);

/**
 * One choice. `product` is the product its text names (the answered product for STORES and
 * ONLINE, the alternative for COMPARE); `word` is COMPARE's one-word title.
 */
export function quickReplyOption(
  kind: QuickReplyKind,
  language: Language,
  product?: { title: string; word?: string },
): OutboundOption {
  const lang = langOf(language);
  const title = product && NAMES_PRODUCT.includes(kind) ? product.title : '';
  return {
    optionId: `${QUICK_REPLY_PREFIX}${kind.toLowerCase()}:${lang}${title ? `:${title}` : ''}`,
    label: TITLE[kind][lang](product?.word),
  };
}

/** The text a tapped choice sends, rebuilt from its id; null when the id is not a valid choice. */
export function quickReplyText(optionId: string): string | null {
  if (!isQuickReply(optionId)) return null;
  const [kind, lang, ...rest] = optionId.slice(QUICK_REPLY_PREFIX.length).split(':');
  const k = kind?.toUpperCase() as QuickReplyKind;
  if (!(k in TEXT) || (lang !== 'en' && lang !== 'hi')) return null;
  const product = rest.join(':').trim();
  if (k === 'COMPARE' && !product) return null;
  return TEXT[k][lang](product.slice(0, 120));
}

/** A tapped choice becomes the shopper's typed message (same channel, id and time). */
export function asTypedQuickReply(inbound: InboundMessage): InboundMessage {
  if (inbound.content.type !== 'INTERACTIVE_REPLY') return inbound;
  const text = quickReplyText(inbound.content.optionId);
  return text ? { ...inbound, content: { type: 'TEXT', text } } : inbound;
}

const words = (title: string) =>
  title
    .split(/[\s/-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => /\p{L}{3,}/u.test(w));

/**
 * The shortest word of the alternative's title that is not in the bound product's ("Gel" for
 * Ultra-Light Gel Sunscreen next to Mineral Sunscreen) and fits a button; null when none does.
 */
export function compareWord(
  boundTitle: string,
  alternativeTitle: string,
  language: Language,
  kind: 'COMPARE' | 'STORES' = 'COMPARE',
): string | null {
  const bound = new Set(words(boundTitle).map((w) => w.toLowerCase()));
  const room = WHATSAPP_LIMITS.buttonLabel - TITLE[kind][langOf(language)](' ').length + 1;
  // Shortest first; between equals the later word, nearer the product's noun ("Oil-Free Gel …" → "Gel").
  return (
    words(alternativeTitle)
      .map((w, i) => ({ w, i }))
      .filter(({ w }) => !bound.has(w.toLowerCase()) && w.length <= room)
      .sort((a, b) => a.w.length - b.w.length || b.i - a.i)[0]?.w ?? null
  );
}

/** Turns that end the conversation for now: no suggestions after them. */
const CLOSING: readonly TurnType[] = ['THANKS', 'LATER', 'BYE', 'OK', 'COMPLIMENT'];
const PRODUCT_ANSWERS: readonly AiAction[] = ['EDUCATE', 'COMPARE', 'ALTERNATIVE_PRODUCT'];

export interface QuickReplyState {
  action: AiAction;
  /** What the turn executed (RESERVATION_CREATED = a hold confirmation). */
  executed: string | null;
  /** The turn already has its own buttons or a link button (store choice, hold confirm, buy online). */
  hasButtons: boolean;
  turn: TurnType | null;
  language: Language;
  /** A person owns the conversation, or this turn hands it over. */
  handedOff: boolean;
  handoffEnabled: boolean;
  /** A product is in play: the one this turn answered about, or the bound intent's. */
  productBound: boolean;
  /** Its title, named in the text of "Show stores near me" and "Buy online" (null when unknown). */
  productTitle: string | null;
  /** A verified alternative to compare with: its full title and the word for the button. */
  compareWith: { title: string; word: string } | null;
  /** After a comparison: the two products compared, each with the word for its store button. */
  compared?: { title: string; word: string }[] | null;
  onlinePurchaseAvailable: boolean;
  /** A store search ran this turn (not just a question for the shopper's location). */
  storeSearchRan: boolean;
  /** A store with stock was found this turn. */
  storesFound: boolean;
  /** WhatsApp's 24-hour customer service window is open (free-form interactive messages allowed). */
  windowOpen: boolean;
}

/** The 2–3 choices for this turn (or none), by rules. */
export function suggestedReplies(s: QuickReplyState): OutboundOption[] {
  if (!s.windowOpen || s.hasButtons || s.handedOff) return [];
  if (s.action === 'HUMAN_HANDOFF' || s.action === 'STORE_RESERVATION' || s.executed === 'RESERVATION_CREATED')
    return [];
  if (s.turn && CLOSING.includes(s.turn)) return [];
  const kinds: [QuickReplyKind, { title: string; word?: string }?][] = [];
  const answered = s.productTitle ? { title: s.productTitle } : undefined;
  if (s.action === 'COMPARE' && s.compared?.length === 2) {
    // Which one? A store button for each product compared ("Stores for Mineral", "Stores for Gel").
    kinds.push(['STORES', s.compared[0]], ['STORES', s.compared[1]]);
  } else if (PRODUCT_ANSWERS.includes(s.action) && s.productBound) {
    kinds.push(['STORES', answered]);
    if (s.compareWith && s.action !== 'COMPARE') kinds.push(['COMPARE', s.compareWith]);
    if (s.onlinePurchaseAvailable && kinds.length < 2) kinds.push(['ONLINE', answered]);
  } else if (s.action === 'STORE_DISCOVERY' && s.productBound && s.storeSearchRan && !s.storesFound) {
    // Searched, nothing in stock nearby: another area, online, a person.
    kinds.push(['AREA']);
    if (s.onlinePurchaseAvailable) kinds.push(['ONLINE', answered]);
  } else return [];
  if (s.handoffEnabled) kinds.push(['PERSON']);
  const options = kinds
    .slice(0, MAX_QUICK_REPLIES)
    .map(([kind, product]) => quickReplyOption(kind, s.language, product))
    .filter((o) => o.label.length <= WHATSAPP_LIMITS.buttonLabel && o.optionId.length <= WHATSAPP_LIMITS.optionId);
  // 2–3 choices or none: a single suggestion is not worth a button row.
  return options.length >= 2 ? options : [];
}
