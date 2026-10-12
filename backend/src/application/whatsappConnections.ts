import { randomInt } from 'node:crypto';
import type { BrandPrincipal } from '../domain/principal.js';
import { isMetaId, maskPhoneNumber } from '../domain/whatsappNumbers.js';
import { AppError } from '../lib/errors.js';
import type { AuditRepository } from '../ports/repositories.js';
import {
  WhatsAppApiError,
  type WhatsAppConnection,
  type WhatsAppConnectionStore,
  type WhatsAppGraphApi,
} from '../ports/whatsapp.js';

/** How long a resolved sender is reused (one conversation turn sends several messages). */
const SENDER_TTL_MS = 30_000;

export interface WhatsAppStatusView {
  status: 'CONNECTED' | 'RESTRICTED' | 'NOT_CONNECTED';
  /** "+91 •••• 4821" — never the full number. */
  display_phone_number: string | null;
  verified_name: string | null;
  quality_rating: string | null;
  connected_at: string | null;
  /** Local profile: a single dev number answers brands without their own connection. */
  dev_number: boolean;
}

const bad = (code: string, message: string, status = 400) => new AppError(status, code, message);

/**
 * Each brand's WhatsApp Business number (L2-WhatsApp). Connect = Meta Embedded Signup: the
 * browser hands over a 30-second code and the WABA / number ids; the backend exchanges the
 * code for a business token, checks the token can see the number, subscribes the app to the
 * WABA (webhooks), registers the number for Cloud API with a fresh 6-digit PIN, and stores
 * token and PIN encrypted. One number belongs to one brand. Sending resolves the brand's
 * own sender (short cache); in the local profile a dev number covers brands with none.
 */
export class WhatsAppConnections {
  private readonly cache = new Map<string, { sender: { phoneNumberId: string; token: string } | null; at: number }>();

  constructor(
    private readonly deps: {
      store: WhatsAppConnectionStore;
      api: WhatsAppGraphApi;
      audit: AuditRepository;
      devNumber?: { accessToken: string; phoneNumberId: string } | null;
      now?: () => Date;
      pin?: () => string;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** The brand's sending identity, or null (no connection and no dev number). */
  async senderFor(brandId: string): Promise<{ phoneNumberId: string; token: string } | null> {
    const hit = this.cache.get(brandId);
    if (hit && this.now().getTime() - hit.at < SENDER_TTL_MS) return hit.sender;
    const c = await this.deps.store.get(brandId);
    const sender =
      c && c.status !== 'DISCONNECTED'
        ? { phoneNumberId: c.phoneNumberId, token: c.businessToken }
        : this.deps.devNumber
          ? { phoneNumberId: this.deps.devNumber.phoneNumberId, token: this.deps.devNumber.accessToken }
          : null;
    this.cache.set(brandId, { sender, at: this.now().getTime() });
    return sender;
  }

  /** The brand for an inbound webhook's phone_number_id (the dev number maps to the demo brand). */
  async brandForPhoneNumber(phoneNumberId: string, devBrandId: string | null): Promise<string | null> {
    const brand = await this.deps.store.brandForPhoneNumber(phoneNumberId);
    if (brand) return brand;
    return this.deps.devNumber && phoneNumberId === this.deps.devNumber.phoneNumberId ? devBrandId : null;
  }

  /** The number customers should message for this brand ("Need it today?" wa.me link), or null. */
  async publicNumber(brandId: string): Promise<string | null> {
    const c = await this.deps.store.get(brandId);
    return c && c.status === 'CONNECTED' ? c.displayPhoneNumber : null;
  }

  async status(brandId: string): Promise<WhatsAppStatusView> {
    const c = await this.deps.store.get(brandId);
    return {
      status: !c ? 'NOT_CONNECTED' : c.status === 'RESTRICTED' ? 'RESTRICTED' : 'CONNECTED',
      display_phone_number: c ? maskPhoneNumber(c.displayPhoneNumber) : null,
      verified_name: c?.verifiedName ?? null,
      quality_rating: c?.qualityRating ?? null,
      connected_at: c?.connectedAt ?? null,
      dev_number: !c && !!this.deps.devNumber,
    };
  }

  private audit(principal: BrandPrincipal, action: string, result: 'SUCCESS' | 'FAILED', reason: string | null) {
    return this.deps.audit.recordBrandEvent({
      brandId: principal.brandId,
      actorType: 'USER',
      actorId: principal.userId,
      action,
      targetType: 'CONNECTION',
      targetId: 'WHATSAPP',
      result,
      reasonCode: reason,
    });
  }

  async connect(
    principal: BrandPrincipal,
    body: { code?: unknown; waba_id?: unknown; phone_number_id?: unknown },
  ): Promise<WhatsAppStatusView> {
    const { code, waba_id: wabaId } = body;
    if (typeof code !== 'string' || code.length < 10 || code.length > 2048 || !isMetaId(wabaId)) {
      throw bad('INVALID_REQUEST', 'Connecting WhatsApp needs the signup code and the WhatsApp Business Account id.');
    }
    if (body.phone_number_id !== undefined && body.phone_number_id !== null && !isMetaId(body.phone_number_id)) {
      throw bad('INVALID_REQUEST', 'The phone number id is not valid.');
    }
    const fail = async (reason: string, err: AppError) => {
      await this.audit(principal, 'WHATSAPP_CONNECTED', 'FAILED', reason);
      return err;
    };

    let token: string;
    try {
      token = await this.deps.api.exchangeCode(code);
    } catch {
      throw await fail(
        'CODE_EXCHANGE_FAILED',
        bad('WHATSAPP_CODE_INVALID', 'Meta did not accept the signup code (it expires after 30 seconds). Try again.'),
      );
    }

    let phoneNumberId = (body.phone_number_id as string | undefined) ?? null;
    try {
      if (!phoneNumberId) {
        // Embedded Signup v4 can finish without naming a number: use the WABA's only number.
        const numbers = await this.deps.api.listPhoneNumbers(wabaId, token);
        if (numbers.length !== 1) {
          throw await fail(
            'NUMBER_REQUIRED',
            bad(
              'WHATSAPP_NUMBER_REQUIRED',
              'Choose the phone number to connect in the WhatsApp signup, then try again.',
            ),
          );
        }
        phoneNumberId = numbers[0]!.id;
      }
      const info = await this.deps.api.getPhoneNumber(phoneNumberId, token);
      if (info.id !== phoneNumberId) throw new WhatsAppApiError('NOT_FOUND', 'number mismatch');
      const holder = await this.deps.store.brandForPhoneNumber(phoneNumberId);
      if (holder && holder !== principal.brandId) {
        throw await fail(
          'NUMBER_TAKEN',
          bad('WHATSAPP_NUMBER_TAKEN', 'This WhatsApp number is already connected to another brand.', 409),
        );
      }
      await this.deps.api.subscribeApp(wabaId, token);
      const pin = (this.deps.pin ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0')))();
      await this.deps.api.registerNumber(phoneNumberId, token, pin);
      const at = this.now().toISOString();
      const connection: WhatsAppConnection = {
        brandId: principal.brandId,
        wabaId,
        phoneNumberId,
        displayPhoneNumber: info.displayPhoneNumber,
        verifiedName: info.verifiedName,
        qualityRating: info.qualityRating,
        status: 'CONNECTED',
        businessToken: token,
        pin,
        connectedAt: at,
        updatedAt: at,
      };
      if (!(await this.deps.store.save(connection))) {
        throw await fail(
          'NUMBER_TAKEN',
          bad('WHATSAPP_NUMBER_TAKEN', 'This WhatsApp number is already connected to another brand.', 409),
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof WhatsAppApiError) {
        throw await fail(
          `GRAPH_${err.kind}`,
          bad(
            'WHATSAPP_CONNECT_FAILED',
            err.kind === 'NOT_FOUND' || err.kind === 'UNAUTHORIZED'
              ? 'The connected account cannot use that phone number. Try the signup again.'
              : 'Meta could not finish connecting the number. Try again in a moment.',
            502,
          ),
        );
      }
      throw err;
    }
    this.cache.delete(principal.brandId);
    await this.audit(principal, 'WHATSAPP_CONNECTED', 'SUCCESS', null);
    return this.status(principal.brandId);
  }

  async disconnect(principal: BrandPrincipal): Promise<WhatsAppStatusView> {
    const c = await this.deps.store.get(principal.brandId);
    if (c) {
      // Best effort: stop webhooks for this WABA while the token still works.
      await this.deps.api.unsubscribeApp(c.wabaId, c.businessToken).catch(() => undefined);
      await this.deps.store.disconnect(principal.brandId, this.now().toISOString());
    }
    this.cache.delete(principal.brandId);
    await this.audit(principal, 'WHATSAPP_DISCONNECTED', 'SUCCESS', null);
    return this.status(principal.brandId);
  }

  /** account_update / phone_number_quality_update webhooks: status fields only. */
  async recordAccountEvent(
    wabaId: string,
    patch: { status?: 'CONNECTED' | 'RESTRICTED'; qualityRating?: string },
  ): Promise<number> {
    const brands = await this.deps.store.brandsForWaba(wabaId);
    const at = this.now().toISOString();
    for (const brandId of brands) {
      await this.deps.store.updateStatus(brandId, { ...patch, updatedAt: at });
      this.cache.delete(brandId);
    }
    return brands.length;
  }
}
