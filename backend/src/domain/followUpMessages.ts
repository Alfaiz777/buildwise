/**
 * Personalised follow-up messages (docs/00 §11.8 Change 11, D6). Deterministic templates
 * per intent type, filled ONLY from verified data: the brand's display name, a product
 * title / variant option from the catalogue, and the catalogue category a search matched.
 * Never a price, stock, store availability, policy promise, internal ID, token or PII.
 *
 * Outside the 24-hour window WhatsApp only allows an approved template; the registry
 * below holds the template names and bodies (Meta approval is an L2 task).
 */
import type { MessageParts } from '../ports/messaging.js';
import { OPTION, type ReplyOption } from './agentReplies.js';
import type { MessageKind } from './conversationPolicy.js';
import type { FollowUpType } from './followUpPolicy.js';

export const OPT_OUT_LINE = 'Reply STOP to opt out.';

interface TemplateDef {
  name: string;
  /** {{brand}}, {{product}}, {{category}} placeholders only. */
  body: string;
}

export const FOLLOW_UP_TEMPLATES: Record<FollowUpType, TemplateDef> = {
  SEARCH_EXPLORATION: {
    name: 'qwikspot_search_help_v1',
    body: 'Hi, this is {{brand}}. You were looking at {{category}}. Want help finding the right one?',
  },
  PRODUCT_CONSIDERATION: {
    name: 'qwikspot_consideration_v1',
    body: 'Hi, this is {{brand}}. Still deciding on {{product}}? I can help you compare the options.',
  },
  CART_ABANDONMENT: {
    name: 'qwikspot_cart_reminder_v1',
    body: 'Hi, this is {{brand}}. You still have {{product}} in your cart. Any questions before you complete your order?',
  },
  CHECKOUT_ABANDONMENT: {
    name: 'qwikspot_checkout_help_v1',
    body: 'Hi, this is {{brand}}. Looks like you were checking out with {{product}}. Need a hand finishing your order?',
  },
  STORE_ORIENTED: {
    name: 'qwikspot_store_nearby_v1',
    body: "Hi, this is {{brand}}. Looking for {{product}} today? Reply with your area and I'll help you find a nearby store.",
  },
};

export interface FollowUpMessageInput {
  type: FollowUpType;
  kind: MessageKind;
  brandName: string;
  /** Verified catalogue title, e.g. "Vitamin C Glow Serum". */
  productTitle: string | null;
  /** Verified variant option, e.g. "30 ml". */
  variantTitle: string | null;
  /** Verified catalogue category a search matched. */
  category: string | null;
  /** The intent's variant (for "Find a store near me") and product image (Change 16). */
  variantId?: string | null;
  imageUrl?: string | null;
}

export interface FollowUpMessage {
  kind: MessageKind;
  templateName: string | null;
  /** Template parameters (TEMPLATE only): brand name and verified product data. */
  parameters: Record<string, string>;
  text: string;
  /** Quick replies (Change 16): Find a store near me · Buy online · Talk to a person. */
  options: ReplyOption[];
  parts?: MessageParts;
}

/** Cleans a filler: verified text only, no markup, bounded length. */
const clean = (value: string) =>
  value
    .replace(/[{}<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

export function composeFollowUp(input: FollowUpMessageInput): FollowUpMessage {
  const template = FOLLOW_UP_TEMPLATES[input.type];
  const product = input.productTitle
    ? clean(input.variantTitle ? `${input.productTitle} (${input.variantTitle})` : input.productTitle)
    : 'the product you were looking at';
  const parameters: Record<string, string> = { brand: clean(input.brandName) };
  if (template.body.includes('{{product}}')) parameters.product = product;
  if (template.body.includes('{{category}}'))
    parameters.category = input.category ? clean(input.category) : 'our range';

  const body = template.body.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => parameters[key] ?? '');
  const options: ReplyOption[] = [];
  if (input.variantId) options.push({ option_id: `recheck:${input.variantId}`, label: 'Find a store near me' });
  if (input.productTitle) options.push({ option_id: OPTION.buyOnline, label: 'Buy online' });
  options.push({ option_id: OPTION.handoff, label: 'Talk to a person' });
  return {
    kind: input.kind,
    templateName: input.kind === 'TEMPLATE' ? template.name : null,
    parameters: input.kind === 'TEMPLATE' ? parameters : {},
    text: `${body}\n\n${OPT_OUT_LINE}`,
    options,
    ...(input.imageUrl && input.productTitle
      ? { parts: { header: { type: 'IMAGE' as const, url: input.imageUrl, alt: product } } }
      : {}),
  };
}
