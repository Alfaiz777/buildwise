import { createHmac, timingSafeEqual } from 'node:crypto';
import { layoutOf, MessagePartsError, validateMessage, WHATSAPP_LIMITS } from '../../domain/whatsappLimits.js';
import type {
  DeliveryStatusUpdate,
  InboundContent,
  InboundMessage,
  InboundRequest,
  MessagingProvider,
  OutboundMessage,
  SendResult,
} from '../../ports/messaging.js';
import { WhatsAppApiError, type WhatsAppGraphApi } from '../../ports/whatsapp.js';

/** The brand's sending identity, resolved per send (its own connected number). */
export interface WhatsAppSender {
  phoneNumberId: string;
  token: string;
}

/** What the webhook service hands over for one `changes[].value`, after mapping the number to its brand. */
export interface WhatsAppInboundRaw {
  brandId: string;
  value: {
    metadata?: { phone_number_id?: string };
    messages?: WaMessage[];
    statuses?: WaStatus[];
  };
}

interface WaMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  location?: { latitude?: number; longitude?: number };
  interactive?: { type?: string; button_reply?: { id?: string }; list_reply?: { id?: string } };
  button?: { payload?: string; text?: string };
}

interface WaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
}

/** Meta error codes that retrying will not fix: outside the window, invalid recipient, template issues. */
const PERMANENT_CODES = new Map<number, string>([
  [131047, 'OUTSIDE_SERVICE_WINDOW'],
  [131026, 'INVALID_RECIPIENT'],
  [131051, 'MESSAGE_PARTS_INVALID'],
  [132000, 'TEMPLATE_INVALID'],
  [132001, 'TEMPLATE_INVALID'],
  [132015, 'TEMPLATE_INVALID'],
]);

const iso = (unixSeconds: string | undefined, fallback: string) => {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : fallback;
};

/**
 * WhatsApp Cloud API channel (L2-WhatsApp; docs/06 §10–§11). One Meta app, many brands: every
 * send resolves the brand's own connected number and token (`senderFor`), so brand A's
 * customers are only ever answered from brand A's number. A brand without a connection
 * cannot send (`WHATSAPP_NOT_CONNECTED`) — its customers are on the simulator anyway.
 *
 * Messages are mapped from the channel-neutral shape, already checked by
 * domain/whatsappLimits.ts: text; reply buttons (≤ 3); a list; a CTA URL; an image header;
 * the footer; a location as a separate location message; a template outside the 24 h window.
 */
export class WhatsAppMessagingProvider implements MessagingProvider {
  readonly channel = 'WHATSAPP' as const;

  constructor(
    private readonly deps: {
      appSecret: string;
      api: WhatsAppGraphApi;
      senderFor: (brandId: string) => Promise<WhatsAppSender | null>;
      now?: () => Date;
    },
  ) {}

  /** X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256 of the raw body with the app secret. */
  verifyInbound(request: InboundRequest): void {
    const header = request.headers['x-hub-signature-256'];
    const given = Array.isArray(header) ? header[0] : header;
    if (!request.rawBody || typeof given !== 'string' || !given.startsWith('sha256=')) {
      throw new Error('Invalid WhatsApp signature');
    }
    const expected = createHmac('sha256', this.deps.appSecret).update(request.rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(given.slice(7).toLowerCase(), 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid WhatsApp signature');
  }

  normalizeInbound(raw: unknown): InboundMessage[] {
    const { brandId, value } = raw as WhatsAppInboundRaw;
    if (!brandId || !value || typeof value !== 'object') throw new Error('Not a WhatsApp change value');
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const out: InboundMessage[] = [];
    for (const m of value.messages ?? []) {
      if (!m.id || !m.from || !/^\d{6,20}$/.test(m.from)) continue;
      const content = this.content(m);
      if (!content) continue; // images, audio, stickers, reactions…: not understood yet
      out.push({
        channel: 'WHATSAPP',
        brandId,
        externalCustomerRef: m.from,
        externalMessageId: m.id,
        receivedAt: iso(m.timestamp, now),
        content,
      });
    }
    return out;
  }

  private content(m: WaMessage): InboundContent | null {
    if (m.type === 'text' && m.text?.body) return { type: 'TEXT', text: m.text.body.slice(0, 4000) };
    if (m.type === 'location' && typeof m.location?.latitude === 'number' && typeof m.location.longitude === 'number')
      return { type: 'LOCATION', latitude: m.location.latitude, longitude: m.location.longitude };
    if (m.type === 'interactive') {
      const id = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id;
      if (id) return { type: 'INTERACTIVE_REPLY', optionId: id.slice(0, 200) };
    }
    // A template's quick-reply button carries the payload we set (e.g. "STOP" or an option id).
    if (m.type === 'button' && (m.button?.payload || m.button?.text)) {
      const payload = (m.button.payload || m.button.text)!.slice(0, 200);
      return /^[a-z_]+(:[\w-]+)?$/.test(payload)
        ? { type: 'INTERACTIVE_REPLY', optionId: payload }
        : { type: 'TEXT', text: payload };
    }
    return null;
  }

  normalizeStatus(raw: unknown): DeliveryStatusUpdate[] {
    const { value } = (raw ?? {}) as WhatsAppInboundRaw;
    const map: Record<string, DeliveryStatusUpdate['status']> = {
      sent: 'SENT',
      delivered: 'DELIVERED',
      read: 'READ',
      failed: 'FAILED',
    };
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    return (value?.statuses ?? [])
      .filter((s): s is Required<Pick<WaStatus, 'id' | 'status'>> & WaStatus => !!s.id && !!s.status && !!map[s.status])
      .map((s) => ({ externalMessageId: s.id, status: map[s.status]!, timestamp: iso(s.timestamp, now) }));
  }

  /** The Cloud API payload(s) for one message: the message, then its location (if any). */
  payloads(message: OutboundMessage): Record<string, unknown>[] {
    const to = message.externalCustomerRef;
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
    const { options, parts } = message;
    const main: Record<string, unknown> = { ...base };

    if (message.messageType === 'TEMPLATE' && message.templateName) {
      main.type = 'template';
      main.template = {
        name: message.templateName,
        language: { code: message.templateLanguage ?? 'en' },
        components: message.templateParameters?.length
          ? [{ type: 'body', parameters: message.templateParameters.map((text) => ({ type: 'text', text })) }]
          : [],
      };
    } else {
      const layout = layoutOf(options, parts);
      const footer = parts?.footer ? { footer: { text: parts.footer } } : {};
      const header =
        parts?.header?.type === 'IMAGE'
          ? { header: { type: 'image', image: { link: parts.header.url } } }
          : parts?.header?.type === 'TEXT'
            ? { header: { type: 'text', text: parts.header.text } }
            : {};
      if (layout === 'BUTTONS') {
        main.type = 'interactive';
        main.interactive = {
          type: 'button',
          ...header,
          body: { text: message.text.slice(0, WHATSAPP_LIMITS.interactiveBody) },
          ...footer,
          action: { buttons: options!.map((o) => ({ type: 'reply', reply: { id: o.optionId, title: o.label } })) },
        };
      } else if (layout === 'LIST') {
        const sections = new Map<string, { id: string; title: string; description?: string }[]>();
        for (const o of options!) {
          const key = o.section ?? 'Options';
          sections.set(key, [
            ...(sections.get(key) ?? []),
            { id: o.optionId, title: o.label, ...(o.description ? { description: o.description } : {}) },
          ]);
        }
        main.type = 'interactive';
        main.interactive = {
          type: 'list',
          // A list's header can only be text.
          ...(parts?.header?.type === 'TEXT' ? { header: { type: 'text', text: parts.header.text } } : {}),
          body: { text: message.text.slice(0, WHATSAPP_LIMITS.interactiveBody) },
          ...footer,
          action: {
            button: parts?.listButton ?? 'Choose',
            sections: [...sections].map(([title, rows]) => ({ title, rows })),
          },
        };
      } else if (layout === 'CTA') {
        main.type = 'interactive';
        main.interactive = {
          type: 'cta_url',
          ...header,
          body: { text: message.text.slice(0, WHATSAPP_LIMITS.interactiveBody) },
          ...footer,
          action: { name: 'cta_url', parameters: { display_text: parts!.ctaUrl!.label, url: parts!.ctaUrl!.url } },
        };
      } else if (parts?.header?.type === 'IMAGE') {
        main.type = 'image';
        main.image = { link: parts.header.url, caption: message.text.slice(0, WHATSAPP_LIMITS.interactiveBody) };
      } else {
        main.type = 'text';
        main.text = { body: message.text, preview_url: /https?:\/\//.test(message.text) };
      }
    }
    const out = [main];
    if (parts?.location) {
      out.push({
        ...base,
        type: 'location',
        location: {
          latitude: parts.location.latitude,
          longitude: parts.location.longitude,
          name: parts.location.name,
          address: parts.location.address,
        },
      });
    }
    return out;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!/^\d{6,20}$/.test(message.externalCustomerRef)) {
      return { status: 'FAILED', externalMessageId: null, errorCode: 'NOT_A_WHATSAPP_CUSTOMER' };
    }
    try {
      validateMessage(message);
    } catch (err) {
      if (err instanceof MessagePartsError) {
        return { status: 'FAILED', externalMessageId: null, errorCode: 'MESSAGE_PARTS_INVALID' };
      }
      throw err;
    }
    const sender = await this.deps.senderFor(message.brandId);
    if (!sender) return { status: 'FAILED', externalMessageId: null, errorCode: 'WHATSAPP_NOT_CONNECTED' };
    try {
      let first: string | null = null;
      for (const payload of this.payloads(message)) {
        const id = await this.deps.api.sendMessage(sender.phoneNumberId, sender.token, payload);
        first ??= id;
      }
      return { status: 'SENT', externalMessageId: first, errorCode: null };
    } catch (err) {
      if (err instanceof WhatsAppApiError) {
        const permanent = err.code !== null ? PERMANENT_CODES.get(err.code) : undefined;
        if (permanent) return { status: 'FAILED', externalMessageId: null, errorCode: permanent };
        if (err.kind === 'UNAUTHORIZED')
          return { status: 'FAILED', externalMessageId: null, errorCode: 'WHATSAPP_RECONNECT_REQUIRED' };
        throw err; // transient: the outbound stage retries with the same request id
      }
      throw err;
    }
  }
}
