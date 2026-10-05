/**
 * WhatsApp's interactive-message limits (Change 16, UI-2). Every automated message is
 * checked here before any channel "sends" it — the simulator now, the WhatsApp adapter in
 * L2 — so the demo can never show something real WhatsApp cannot render.
 *
 * Text that is too long is shortened on a word boundary with "…"; structure that WhatsApp
 * would reject (4 buttons, 11 list rows, buttons and a list together, a non-https image)
 * is refused with a typed error.
 */
import type { MessageParts, OutboundOption } from '../ports/messaging.js';

export const WHATSAPP_LIMITS = {
  body: 4096,
  interactiveBody: 1024,
  headerText: 60,
  footer: 60,
  buttons: 3,
  buttonLabel: 20,
  listButton: 20,
  listRows: 10,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  optionId: 200,
  ctaLabel: 20,
  locationName: 100,
  locationAddress: 200,
  imageAlt: 120,
} as const;

export class MessagePartsError extends Error {
  constructor(readonly code: string) {
    super(`Message parts invalid: ${code}`);
    this.name = 'MessagePartsError';
  }
}

/** Shortens to `max` characters on a word boundary, ending with "…". */
export function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type Layout = 'TEXT' | 'BUTTONS' | 'LIST' | 'CTA';

/** Buttons when there are ≤ 3 short choices without descriptions; otherwise a list. */
export function layoutOf(options: OutboundOption[] | undefined, parts: MessageParts | undefined): Layout {
  if (options && options.length > 0) {
    const asButtons =
      options.length <= WHATSAPP_LIMITS.buttons &&
      options.every((o) => o.label.length <= WHATSAPP_LIMITS.buttonLabel && !o.description && !o.section);
    return asButtons ? 'BUTTONS' : 'LIST';
  }
  return parts?.ctaUrl ? 'CTA' : 'TEXT';
}

/** True when WhatsApp would send this as an interactive (or media-header) message. */
export function isInteractive(options: OutboundOption[] | undefined, parts: MessageParts | undefined): boolean {
  return layoutOf(options, parts) !== 'TEXT' || parts?.header !== undefined;
}

function checkUrl(url: string, what: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MessagePartsError(`${what}_URL_INVALID`);
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new MessagePartsError(`${what}_URL_NOT_HTTPS`);
  }
  return parsed;
}

export interface ValidMessage {
  text: string;
  options?: OutboundOption[];
  parts?: MessageParts;
}

/**
 * Returns the message within WhatsApp's limits (text shortened where needed) or throws
 * MessagePartsError for a structure WhatsApp would reject.
 */
export function validateMessage(message: ValidMessage): ValidMessage {
  const options = message.options?.length ? message.options : undefined;
  const parts = message.parts;
  const layout = layoutOf(options, parts);
  if (options && parts?.ctaUrl) throw new MessagePartsError('CTA_WITH_OPTIONS');

  const out: ValidMessage = {
    text: fit(
      message.text,
      layout === 'TEXT' && !parts?.header ? WHATSAPP_LIMITS.body : WHATSAPP_LIMITS.interactiveBody,
    ),
  };

  if (options) {
    const ids = new Set<string>();
    for (const o of options) {
      if (!o.optionId || o.optionId.length > WHATSAPP_LIMITS.optionId) throw new MessagePartsError('OPTION_ID_INVALID');
      if (ids.has(o.optionId)) throw new MessagePartsError('OPTION_ID_DUPLICATE');
      ids.add(o.optionId);
    }
    if (layout === 'LIST') {
      if (options.length > WHATSAPP_LIMITS.listRows) throw new MessagePartsError('TOO_MANY_ROWS');
      out.options = options.map((o) => ({
        optionId: o.optionId,
        label: fit(o.label, WHATSAPP_LIMITS.rowTitle),
        ...(o.description ? { description: fit(o.description, WHATSAPP_LIMITS.rowDescription) } : {}),
        ...(o.section ? { section: fit(o.section, WHATSAPP_LIMITS.sectionTitle) } : {}),
      }));
    } else {
      out.options = options.map((o) => ({ optionId: o.optionId, label: o.label }));
    }
  }

  if (parts) {
    const p: MessageParts = {};
    if (parts.header?.type === 'IMAGE') {
      const url = checkUrl(parts.header.url, 'IMAGE');
      if (!/\.(png|jpe?g)$/i.test(url.pathname)) throw new MessagePartsError('IMAGE_TYPE_UNSUPPORTED');
      p.header = { type: 'IMAGE', url: parts.header.url, alt: fit(parts.header.alt, WHATSAPP_LIMITS.imageAlt) };
    } else if (parts.header?.type === 'TEXT') {
      p.header = { type: 'TEXT', text: fit(parts.header.text, WHATSAPP_LIMITS.headerText) };
    }
    if (parts.footer) p.footer = fit(parts.footer, WHATSAPP_LIMITS.footer);
    if (parts.location) {
      const { latitude, longitude } = parts.location;
      if (!(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)) throw new MessagePartsError('LOCATION_INVALID');
      p.location = {
        name: fit(parts.location.name, WHATSAPP_LIMITS.locationName),
        address: fit(parts.location.address, WHATSAPP_LIMITS.locationAddress),
        latitude,
        longitude,
      };
    }
    if (parts.ctaUrl) {
      checkUrl(parts.ctaUrl.url, 'CTA');
      p.ctaUrl = { label: fit(parts.ctaUrl.label, WHATSAPP_LIMITS.ctaLabel), url: parts.ctaUrl.url };
    }
    if (layout === 'LIST') p.listButton = fit(parts.listButton ?? 'Choose an option', WHATSAPP_LIMITS.listButton);
    if (Object.keys(p).length > 0) out.parts = p;
  } else if (layout === 'LIST') {
    out.parts = { listButton: 'Choose an option' };
  }
  return out;
}
