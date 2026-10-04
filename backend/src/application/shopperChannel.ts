/**
 * The shopper demo channel (Change 16, UI-2): the brand's chat as a shopper sees it, for
 * the public /chat page. It is the simulator channel driven by the shopper instead of a
 * Brand Admin — the same SimulatorService and ConversationPipeline.
 *
 * Identity: the server issues a signed, short-lived session token that carries the
 * customer ref; the browser never chooses a ref. Without a shopper the server makes a
 * fresh `judge_xxxxxxxx`; "sign in as demo shopper" accepts only the synthetic commerce
 * customers and maps them server-side. No new collection: the token is self-verifying.
 *
 * Availability (routes/shopper.ts): local profile always; gcp only with DEMO_MODE on and
 * only for the allowlisted demo brands.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveMessagingSettings } from '../domain/brandSettings.js';
import { AppError, Errors } from '../lib/errors.js';
import type { ConversationRepository, CustomerRepository } from '../ports/conversationRepositories.js';
import type { AuditRepository, BrandRepository } from '../ports/repositories.js';
import { DEMO_SHOPPER_IDS, shopperRef } from './demoStorefrontService.js';
import { messageJson, type SimulatorService } from './simulatorService.js';

export const SHOPPER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BASE32 = 'abcdefghijkmnpqrstuvwxyz23456789';

export interface ShopperSession {
  brandId: string;
  customerRef: string;
  expiresAt: string;
}

export interface ShopperChannelDeps {
  /** HMAC secret; null → a random per-process secret (local only, see config). */
  sessionSecret: string | null;
  /** Which brands may use the channel: all in local, the demo allowlist in gcp. */
  brandAllowed: (brandId: string) => boolean;
  brands: BrandRepository;
  customers: CustomerRepository;
  conversations: ConversationRepository;
  simulator: SimulatorService;
  /** The brand's storefront-origin check (IntentService.brandForOrigin). */
  checkOrigin: (brandId: string, origin: string | undefined) => Promise<unknown>;
  publicOrigin: string;
  audit: AuditRepository;
  now: () => Date;
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString('base64url');

export class ShopperChannelService {
  private readonly secret: Buffer;

  constructor(private readonly deps: ShopperChannelDeps) {
    this.secret = deps.sessionSecret ? Buffer.from(deps.sessionSecret) : randomBytes(32);
  }

  /** Whether this brand's shopper demo exists here (also gates the demo storefront routes). */
  isBrandAllowed(brandId: string): boolean {
    return this.deps.brandAllowed(brandId);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  private invalid(): AppError {
    return new AppError(401, 'SHOPPER_SESSION_INVALID', 'Your chat session has ended. Start a new chat.');
  }

  /** Brand must be allowed for this channel (404 otherwise: the brand's demo does not exist here). */
  private async allowedBrand(brandId: string) {
    if (!this.deps.brandAllowed(brandId)) throw Errors.notFound();
    const brand = await this.deps.brands.getById(brandId);
    if (!brand || brand.status !== 'ACTIVE') throw Errors.notFound();
    return brand;
  }

  /** Issues a session: a fresh guest, or one of the synthetic demo shoppers. */
  async start(input: { brandId: string; shopperId: string | null; origin: string | undefined }) {
    const brand = await this.allowedBrand(input.brandId);
    await this.deps.checkOrigin(brand.brandId, input.origin);
    let customerRef: string;
    if (input.shopperId) {
      if (!DEMO_SHOPPER_IDS.includes(input.shopperId)) {
        throw new AppError(404, 'UNKNOWN_SHOPPER', 'This demo shopper does not exist.');
      }
      customerRef = shopperRef(input.shopperId);
    } else {
      const bytes = randomBytes(8);
      customerRef = `judge_${[...bytes].map((b) => BASE32[b % BASE32.length]).join('')}`;
    }
    const now = this.deps.now();
    const expiresAt = new Date(now.getTime() + SHOPPER_SESSION_TTL_MS);
    const payload = b64(
      JSON.stringify({ v: 1, b: brand.brandId, r: customerRef, iat: now.getTime(), exp: expiresAt.getTime() }),
    );
    await this.deps.audit.recordBrandEvent({
      brandId: brand.brandId,
      actorType: 'SYSTEM',
      actorId: 'shopper-channel',
      action: 'SHOPPER_SESSION_STARTED',
      targetType: 'SHOPPER_SESSION',
      targetId: customerRef,
      result: 'SUCCESS',
      reasonCode: input.shopperId ? 'DEMO_SHOPPER' : 'GUEST',
    });
    const messaging = resolveMessagingSettings(brand.settings, brand.name);
    return {
      session_token: `${payload}.${this.sign(payload)}`,
      expires_at: expiresAt.toISOString(),
      brand: {
        brand_id: brand.brandId,
        display_name: messaging.displayName,
        logo_url: messaging.logoUrl ? this.absolute(messaging.logoUrl) : null,
      },
    };
  }

  private absolute(url: string) {
    return /^https?:\/\//.test(url) ? url : `${this.deps.publicOrigin}/${url.replace(/^\//, '')}`;
  }

  /** Verifies a token: signature (constant time), version, expiry and brand allowance. */
  verify(token: string | undefined): ShopperSession {
    if (!token || token.length > 1024) throw this.invalid();
    const [payload, signature] = token.split('.');
    if (!payload || !signature) throw this.invalid();
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw this.invalid();
    let data: { v?: number; b?: string; r?: string; exp?: number };
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw this.invalid();
    }
    if (data.v !== 1 || typeof data.b !== 'string' || typeof data.r !== 'string' || typeof data.exp !== 'number') {
      throw this.invalid();
    }
    if (data.exp <= this.deps.now().getTime()) throw this.invalid();
    if (!this.deps.brandAllowed(data.b) || !/^[A-Za-z0-9_-]{1,64}$/.test(data.r)) throw this.invalid();
    return { brandId: data.b, customerRef: data.r, expiresAt: new Date(data.exp).toISOString() };
  }

  /** A shopper message → the simulator channel, as this session's customer. */
  async send(session: ShopperSession, origin: string | undefined, body: { clientMessageId: string; content: unknown }) {
    await this.allowedBrand(session.brandId);
    await this.deps.checkOrigin(session.brandId, origin);
    const result = await this.deps.simulator.handleAsCustomer(session.brandId, {
      simulator_customer_ref: session.customerRef,
      client_message_id: body.clientMessageId,
      content: body.content,
    });
    return { conversation_id: result.conversation_id, messages: result.outbound_messages };
  }

  /** This session's own conversation only: messages after `afterMessageId` (polling). */
  async messages(session: ShopperSession, afterMessageId: string | undefined) {
    await this.allowedBrand(session.brandId);
    const customer = await this.deps.customers.findByIdentity(session.brandId, {
      channel: 'SIMULATOR',
      externalRef: `sim:${session.customerRef}`,
    });
    const conversation = customer
      ? await this.deps.conversations.findForCustomer(session.brandId, customer.customerId, 'SIMULATOR')
      : null;
    if (!conversation) return { conversation_id: null, messages: [] };
    const messages = await this.deps.conversations.listMessages(
      session.brandId,
      conversation.conversationId,
      afterMessageId,
    );
    return { conversation_id: conversation.conversationId, messages: messages.map(customerMessageJson) };
  }
}

/**
 * What the shopper's phone shows: the message and its parts. Internal labels (origin,
 * message kind, template name) are kept for the brand view only.
 */
export function customerMessageJson(m: Parameters<typeof messageJson>[0]) {
  const { origin: _origin, message_kind: _kind, template_name: _template, ...rest } = messageJson(m);
  return { ...rest, from: m.direction === 'INBOUND' ? ('SHOPPER' as const) : ('BRAND' as const) };
}
