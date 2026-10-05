/**
 * Deterministic customer replies built ONLY from verified data: tool outputs and the
 * catalogue (docs/00 §11.8 Change 12, E3). No reply promises a pickup time; "Only 1 left"
 * appears only when the verified available quantity is exactly 1; store hours, distances
 * and prices are copied from tool results, never computed from text.
 */
import type { MessageParts } from '../ports/messaging.js';
import type {
  NearbyStoresOutput,
  ProductSheet,
  ReservationToolOutput,
  StoreOption,
  VariantView,
} from './agentTools.js';

/** A tap-able choice. A description or section turns the choices into a list (Change 16). */
export interface ReplyOption {
  option_id: string;
  label: string;
  description?: string;
  section?: string;
}

/**
 * A customer reply: the body (WhatsApp formatting), its choices and structured parts
 * (Change 16). Built only from verified data; checked against WhatsApp's limits on send.
 */
export interface Reply {
  message_type: 'TEXT' | 'INTERACTIVE';
  text: string;
  options?: ReplyOption[];
  parts?: MessageParts;
}

export const OPTION = {
  hold: (storeId: string) => `hold:${storeId}`,
  otherStores: 'other_stores',
  buyOnline: 'buy_online',
  cancel: (reservationId: string) => `cancel:${reservationId}`,
  /** "Talk to a person" on a follow-up (Change 16): the existing human-handoff path. */
  handoff: 'handoff',
} as const;

export type ParsedOption =
  | { kind: 'HOLD'; storeId: string }
  | { kind: 'OTHER_STORES' }
  | { kind: 'BUY_ONLINE' }
  | { kind: 'CANCEL'; reservationId: string }
  | { kind: 'RECHECK'; variantId: string }
  | { kind: 'HANDOFF' }
  | { kind: 'UNKNOWN' };

/** Reply options → channel options (same ids; description/section kept for lists). */
export const toOutboundOptions = (options: ReplyOption[] | undefined) =>
  options?.map((o) => ({
    optionId: o.option_id,
    label: o.label,
    ...(o.description ? { description: o.description } : {}),
    ...(o.section ? { section: o.section } : {}),
  }));

export function parseOption(optionId: string): ParsedOption {
  if (optionId === OPTION.otherStores) return { kind: 'OTHER_STORES' };
  if (optionId === OPTION.buyOnline) return { kind: 'BUY_ONLINE' };
  if (optionId === OPTION.handoff) return { kind: 'HANDOFF' };
  if (optionId.startsWith('hold:') && optionId.length > 5) return { kind: 'HOLD', storeId: optionId.slice(5) };
  if (optionId.startsWith('cancel:') && optionId.length > 7)
    return { kind: 'CANCEL', reservationId: optionId.slice(7) };
  if (optionId.startsWith('recheck:') && optionId.length > 8) return { kind: 'RECHECK', variantId: optionId.slice(8) };
  return { kind: 'UNKNOWN' };
}

export const formatKm = (km: number) => `${km.toFixed(1)} km`;
export const formatPrice = (price: number, currency: string) =>
  currency === 'INR' ? `₹${price}` : `${currency} ${price}`;
const shortName = (storeName: string) => storeName.replace(/\s+store$/i, '').trim() || storeName;
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
export const variantLabel = (v: Pick<VariantView, 'product_title' | 'variant_title'>) =>
  `${v.product_title} ${v.variant_title}`;

const storeFacts = (s: StoreOption) =>
  s.open_until ? `${formatKm(s.distance_km)}, open until ${s.open_until}` : formatKm(s.distance_km);
/** "2.1 km · open until 21:00" — the facts line of a card or a list row. */
const storeFactsLine = (s: StoreOption) =>
  s.open_until ? `${formatKm(s.distance_km)} · open until ${s.open_until}` : formatKm(s.distance_km);

/** https://www.google.com/maps/search/?api=1&query=<lat>,<lng> from the store's own coordinates. */
export const mapsLink = (latitude: number, longitude: number) =>
  `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

/** "30 Sep, 18:00" in the store's timezone. */
export function formatStockTime(iso: string, timezone: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return `${day}, ${time}`;
}

/** Stale stock is never claimed without saying when it was last updated (Change 14, G1). */
export function stockNote(s: Pick<StoreOption, 'stale' | 'stock_updated_at' | 'timezone' | 'store_name'>): string {
  if (!s.stale) return '';
  return s.stock_updated_at
    ? ` ${s.store_name}'s stock was last updated ${formatStockTime(s.stock_updated_at, s.timezone)} (store time), so it may have changed.`
    : ` We don't know when ${s.store_name}'s stock was last updated, so it may have changed.`;
}

/** "Hold at Andheri" — a WhatsApp button label is at most 20 characters. */
export function holdLabel(storeName: string): string {
  const label = `Hold at ${shortName(storeName)}`;
  return label.length <= 20 ? label : 'Hold here';
}

const holdOption = (s: StoreOption) => ({ option_id: OPTION.hold(s.store_id), label: holdLabel(s.store_name) });

/** The product card's image header, when the catalogue has an image (Change 16). */
export function productImage(
  v: Pick<VariantView, 'image_url' | 'product_title' | 'variant_title'>,
): MessageParts | undefined {
  return v.image_url ? { header: { type: 'IMAGE', url: v.image_url, alt: variantLabel(v) } } : undefined;
}

function approximateNote(origin: { approximate: boolean; locality: string | null } | null): string {
  return origin?.approximate && origin.locality
    ? ` (Distances are approximate, from ${titleCase(origin.locality)}.)`
    : '';
}

/**
 * Store found (Change 16): a product card — image header, "*Product* · price", the store
 * and its facts — with Hold · Other stores · Buy online.
 */
export function storeProposalReply(input: {
  variant: VariantView;
  stores: StoreOption[];
  origin: { approximate: boolean; locality: string | null } | null;
  onlineAvailable: boolean;
  /** False when the brand has reservations switched off: no Hold option is offered. */
  canHold?: boolean;
  prefix?: string;
}): Reply {
  const [best, ...others] = input.stores;
  if (!best) throw new Error('storeProposalReply needs at least one eligible store');
  const canHold = input.canHold !== false;
  const lines = [
    ...(input.prefix ? [input.prefix] : []),
    `*${variantLabel(input.variant)}* · ${formatPrice(input.variant.price, input.variant.currency)}`,
    `Available today at *${best.store_name}*`,
    storeFactsLine(best) + (best.available_quantity === 1 ? ' · Only 1 left.' : ''),
  ];
  const notes = `${stockNote(best)}${approximateNote(input.origin)}`.trim();
  if (notes) lines.push(notes);
  lines.push(
    canHold ? 'I can hold one for you to pick up and pay at the store.' : 'You can pick it up and pay at the store.',
  );
  const options = canHold ? [holdOption(best)] : [];
  if (others.length > 0) options.push({ option_id: OPTION.otherStores, label: 'Other stores' });
  if (input.onlineAvailable) options.push({ option_id: OPTION.buyOnline, label: 'Buy online' });
  return { message_type: 'INTERACTIVE', text: lines.join('\n'), options, parts: productImage(input.variant) };
}

/** Other stores (Change 16): a list — one row per store (up to 9) and a "Buy online" row. */
export function otherStoresReply(input: {
  variant: VariantView;
  stores: StoreOption[];
  onlineAvailable: boolean;
  canHold?: boolean;
}): Reply {
  const shown = input.stores.slice(0, 9);
  const describe = (s: StoreOption) =>
    `${storeFactsLine(s)}${s.available_quantity === 1 ? ' · only 1 left' : ''}` +
    (s.stale && s.stock_updated_at
      ? ` · stock as of ${formatStockTime(s.stock_updated_at, s.timezone)}`
      : s.stale
        ? ' · stock time unknown'
        : '');
  const text = `Other stores with *${variantLabel(input.variant)}* today:`;
  if (input.canHold === false) {
    return {
      message_type: input.onlineAvailable ? 'INTERACTIVE' : 'TEXT',
      text: `${text}\n${shown.map((s) => `• ${s.store_name} — ${describe(s)}`).join('\n')}`,
      ...(input.onlineAvailable ? { options: [{ option_id: OPTION.buyOnline, label: 'Buy online' }] } : {}),
    };
  }
  const options: ReplyOption[] = shown.map((s) => ({
    option_id: OPTION.hold(s.store_id),
    label: s.store_name,
    description: describe(s),
    section: 'Stores near you',
  }));
  if (input.onlineAvailable) {
    options.push({
      option_id: OPTION.buyOnline,
      label: 'Buy online',
      description: 'Order on our website',
      section: 'Or',
    });
  }
  return { message_type: 'INTERACTIVE', text, options, parts: { listButton: 'Choose a store' } };
}

function localDate(iso: string, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** "14:30" in the store's timezone, prefixed with the weekday when it is not today there. */
export function formatHoldUntil(expiresAt: string, timezone: string, now: Date): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(expiresAt));
  if (localDate(expiresAt, timezone) === localDate(now.toISOString(), timezone)) return time;
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long' }).format(new Date(expiresAt));
  return `${day} ${time}`;
}

/**
 * Hold confirmed — the pickup pass (Change 16): store, address, pickup code, hold-until in
 * store time and "pay at the store"; the store's location as a location part; Cancel.
 */
export function confirmationReply(result: ReservationToolOutput, now: Date): Reply {
  const r = result.reservation!;
  const store = result.store!;
  const product = result.variant ? variantLabel(result.variant) : 'your item';
  const address =
    store.address && store.address.toLowerCase().includes(store.city.toLowerCase())
      ? store.address
      : [store.address, store.city].filter(Boolean).join(', ');
  const lines = [
    '✅ *On hold for you*',
    `${r.quantity} × ${product}`,
    `*${store.store_name}*${address ? `, ${address}` : ''}`,
    `Pickup code: *${r.pickup_code}*`,
    `Held until ${formatHoldUntil(r.expires_at, store.timezone ?? 'UTC', now)} (store time) · pay at the store`,
    "The store will confirm when it's ready.",
  ];
  const location =
    store.latitude !== null && store.longitude !== null
      ? { name: store.store_name, address: address || store.city, latitude: store.latitude, longitude: store.longitude }
      : null;
  return {
    message_type: 'INTERACTIVE',
    text: lines.join('\n'),
    options: [{ option_id: OPTION.cancel(r.reservation_id), label: 'Cancel reservation' }],
    ...(location ? { parts: { location } } : {}),
  };
}

/** No eligible store: a verified alternative (if one is eligible) and/or the online store. */
export function noEligibleStoreReply(input: {
  variant: VariantView;
  alternative: { variant: VariantView; store: StoreOption } | null;
  canHold?: boolean;
  prefix?: string;
}): Reply {
  const parts = [
    `${input.prefix ? `${input.prefix} ` : ''}${variantLabel(input.variant)} isn't available for pickup at a store near you right now.`,
  ];
  const options: { option_id: string; label: string }[] = [];
  if (input.alternative) {
    const { variant, store } = input.alternative;
    parts.push(
      `${variantLabel(variant)} (${formatPrice(variant.price, variant.currency)}) is available today at ${store.store_name} (${storeFacts(store)}).${stockNote(store)}`,
    );
    if (input.canHold !== false) options.push(holdOption(store));
  }
  if (input.variant.online_url) {
    parts.push(`You can also order ${input.variant.product_title} online: ${input.variant.online_url}`);
    options.push({ option_id: OPTION.buyOnline, label: 'Buy online' });
  } else {
    parts.push('You can also order it from our online store.');
  }
  return options.length > 0
    ? { message_type: 'INTERACTIVE', text: parts.join(' '), options }
    : { message_type: 'TEXT', text: parts.join(' ') };
}

/**
 * The reply for one find_nearby_stores result: ask for a location, resolve an ambiguous
 * area, list other stores (when stores were excluded on request) or propose the best one.
 * Null when no store is eligible (the caller decides between an alternative and online).
 */
export function discoveryReply(find: NearbyStoresOutput, opts: { canHold: boolean; prefix?: string }): Reply | null {
  const label = find.variant ? variantLabel(find.variant) : null;
  if (find.status === 'LOCATION_REQUIRED') return askLocationReply(label);
  if (find.status === 'AMBIGUOUS_AREA') return ambiguousAreaReply(find.ambiguous_areas);
  if (find.status !== 'OK' || !find.variant || find.eligible.length === 0) return null;
  const onlineAvailable = find.variant.online_url !== null;
  if (find.skipped_stores.length > 0 && !opts.prefix)
    return otherStoresReply({ variant: find.variant, stores: find.eligible, onlineAvailable, canHold: opts.canHold });
  return storeProposalReply({
    variant: find.variant,
    stores: find.eligible,
    origin: find.origin,
    onlineAvailable,
    canHold: opts.canHold,
    prefix: opts.prefix,
  });
}

export function onlinePurchaseReply(input: { title: string; url: string | null }): Reply {
  return {
    message_type: 'TEXT',
    text: input.url
      ? `You can order ${input.title} online here: ${input.url}`
      : `You can order ${input.title} from our online store.`,
  };
}

export const askLocationReply = (productLabel: string | null): Reply => ({
  message_type: 'TEXT',
  text: `To check stores near you${productLabel ? ` for ${productLabel}` : ''}, please share your location or tell me your area.`,
});

export const ambiguousAreaReply = (areas: string[]): Reply => ({
  message_type: 'TEXT',
  text: `I found more than one area in your message (${areas.map(titleCase).join(', ')}). Which one are you nearest to? You can also share your location.`,
});

export const noPendingHoldReply = (): Reply => ({
  message_type: 'TEXT',
  text: "I don't have a store hold waiting for you right now. Tell me your area or share your location and I'll check which nearby store has it today.",
});

export const whichProductReply = (candidates: { title: string }[]): Reply => ({
  message_type: 'TEXT',
  text: candidates.length
    ? `Which product do you mean: ${candidates.map((c) => c.title).join(', ')}? Please include the size.`
    : 'Which product and size are you looking for?',
});

const BLOCK_TEXT: Record<string, string> = {
  OUT_OF_STOCK: 'no longer has it in stock',
  STORE_CLOSED: 'is closed right now',
  NOT_ELIGIBLE: "can't take this reservation right now",
  STORE_INACTIVE: "can't take reservations right now",
  RESERVATIONS_DISABLED: "can't take reservations right now",
  QUANTITY_LIMIT_EXCEEDED: "can't hold that many units",
};

/** "Sorry — Bandra Store no longer has it in stock." (the verified reason only). */
export const blockedPrefix = (storeName: string | null, reason: string) =>
  `Sorry — ${storeName ?? 'that store'} ${BLOCK_TEXT[reason] ?? "can't take this reservation right now"}.`;

export const cancelledReply = (result: ReservationToolOutput): Reply => ({
  message_type: 'TEXT',
  text: `Your reservation${result.store ? ` at ${result.store.store_name}` : ''}${
    result.reservation ? ` (pickup code ${result.reservation.pickup_code})` : ''
  } is cancelled.`,
});

export const cancelNotFoundReply = (): Reply => ({
  message_type: 'TEXT',
  text: "I couldn't find an active reservation of yours to cancel.",
});

export const refusalReply = (): Reply => ({
  message_type: 'TEXT',
  text: "Sorry, I can't help with that. I can help with our products, finding a nearby store that has them today, or holding one for you to pick up.",
});

export const handoffReply = (brandName: string): Reply => ({
  message_type: 'TEXT',
  text: `Thanks. I've asked a member of the ${brandName} team to take over this conversation. They will reply here.`,
});

export const clarifyReply = (productTitle: string | null): Reply => ({
  message_type: 'TEXT',
  text: `Happy to help${productTitle ? ` with ${productTitle}` : ''}. Would you like product details, a nearby store that has it today, or to order online?`,
});

const TOPICS: { pattern: RegExp; keys: string[] }[] = [
  { pattern: /\b(skin|oily|dry|sensitive|combination|normal)\b/i, keys: ['skin_type'] },
  { pattern: /\b(ingredients?|contain|contains|made of|what'?s in)\b/i, keys: ['key_ingredients'] },
  { pattern: /\b(texture|feel|sticky|greasy|heavy|light)\b/i, keys: ['texture'] },
  { pattern: /\b(when|morning|night|evening|how (to|do i) use|apply|routine)\b/i, keys: ['usage'] },
  { pattern: /\b(concern|dull|dullness|pores?|acne|spots?|hydrat\w*|good for|help with)\b/i, keys: ['concern'] },
];

const attrLabel = (key: string) => titleCase(key.replace(/_/g, ' ')).replace(/^(\w)/, (c) => c.toUpperCase());

/** The attribute keys a product question is about (verified data only is quoted). */
export function questionAttributes(question: string): string[] {
  return [...new Set(TOPICS.filter((t) => t.pattern.test(question)).flatMap((t) => t.keys))];
}

/** EDUCATE: quotes only attributes the catalogue has; otherwise says so. */
export function educateReply(product: ProductSheet, question: string): { reply: Reply; grounded: boolean } {
  const keys = questionAttributes(question).filter((k) => product.attributes[k]);
  if (keys.length === 0) {
    return {
      grounded: false,
      reply: {
        message_type: 'TEXT',
        text: `I don't have verified information about that for ${product.title}. I can connect you with our team if you'd like.`,
      },
    };
  }
  const facts = keys.map((k) => `• ${attrLabel(k)}: ${product.attributes[k]}`);
  return {
    grounded: true,
    reply: {
      message_type: 'TEXT',
      text: `*${product.title}* — from our product information:\n${facts.join('\n')}`,
    },
  };
}

const COMPARE_KEYS = ['concern', 'skin_type', 'key_ingredients', 'texture', 'usage'];

/** COMPARE: shared verified attributes and prices, then a clarifying question. */
export function compareReply(a: ProductSheet, b: ProductSheet): Reply {
  const keys = COMPARE_KEYS.filter((k) => a.attributes[k] && b.attributes[k]);
  const block = (p: ProductSheet) => {
    const facts = keys.map((k) => `• ${attrLabel(k)}: ${p.attributes[k]}`);
    const prices = p.variants.map((v) => `${v.title} ${formatPrice(v.price, v.currency)}`).join(', ');
    return [`*${p.title}*`, ...facts, `• Price: ${prices}`].join('\n');
  };
  return {
    message_type: 'TEXT',
    text: `Here's how they compare, from our product information:\n\n${block(a)}\n\n${block(b)}\n\nWhich matters more to you — your skin type or the main concern you want to treat?`,
  };
}

export const fallbackRetryText = 'Sorry, something went wrong on our side. Please try again in a moment.';
