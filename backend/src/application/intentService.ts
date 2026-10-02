import { randomBytes } from 'node:crypto';
import { allowedStorefrontOrigins, resolveMessagingSettings } from '../domain/brandSettings.js';
import {
  applyWebEvent,
  looksLikePii,
  matchSearchCategory,
  normalizeSearchTerm,
  PRODUCT_EVENTS,
  type IntentClassification,
  type WebEventType,
  type WhatsAppEntry,
} from '../domain/intentClassification.js';
import {
  encodeIntentToken,
  hashIntentToken,
  MAX_TOKENS_PER_SESSION_PER_HOUR,
  prefilledText,
  TOKEN_TTL_MS,
} from '../domain/intentToken.js';
import { AppError } from '../lib/errors.js';
import { hashedId, sha256Hex } from '../lib/ids.js';
import type {
  IntentRecord,
  IntentRepository,
  IntentTokenRepository,
  VisitorLinkRepository,
} from '../ports/conversationRepositories.js';
import type { BrandRecord, BrandRepository, ProductRepository } from '../ports/repositories.js';
import type { EventRecorder } from './eventRecorder.js';

export interface StorefrontEventInput {
  brandId: string;
  webSessionId: string;
  visitorId: string | null;
  clientEventId: string;
  eventType: WebEventType;
  shopifyVariantId: string | null;
  searchTerm: string | null;
  entry: WhatsAppEntry | null;
}

export interface StorefrontEventResult {
  accepted: true;
  replay: boolean;
  intent: IntentRecord;
  whatsapp: { prefilledText: string; waLink: string | null; expiresAt: string } | null;
}

export interface IntentServiceDeps {
  brands: BrandRepository;
  products: ProductRepository;
  intents: IntentRepository;
  tokens: IntentTokenRepository;
  visitors: VisitorLinkRepository;
  events: EventRecorder;
  now?: () => Date;
  /** Hook for the follow-up engine (called after every intent update). */
  onIntentUpdated?: (intent: IntentRecord) => Promise<void>;
}

const MAX_PROCESSED_IDS = 100;

/** Deterministic IDs: one intent per web session; visitor links by hash only. */
export const intentIdFor = (brandId: string, webSessionId: string) => hashedId('int', `${brandId}:${webSessionId}`, 20);
export const visitorHashOf = (visitorId: string) => sha256Hex(`visitor:${visitorId}`);

/**
 * Storefront intent (docs/06_INTEGRATION_CONTRACTS.md §14.1, docs/04 §11): records the
 * behavioural event, updates the session's CustomerIntent with the deterministic rules,
 * and for WHATSAPP_CLICK issues the handshake token (§10.1). Anonymous by default: the
 * intent gets a customer only through a linked visitor (docs/00 Change 11, D1).
 */
export class IntentService {
  private readonly now: () => Date;

  constructor(private readonly deps: IntentServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The brand, if it exists, is active, and allows this storefront origin. */
  async brandForOrigin(brandId: string, origin: string | undefined): Promise<BrandRecord> {
    const brand = await this.deps.brands.getById(brandId);
    if (!brand || brand.status !== 'ACTIVE' || !origin || !allowedStorefrontOrigins(brand.settings).includes(origin)) {
      throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'This storefront is not allowed to send events.');
    }
    return brand;
  }

  async recordEvent(brand: BrandRecord, input: StorefrontEventInput): Promise<StorefrontEventResult> {
    const brandId = brand.brandId;
    const now = this.now();
    const at = now.toISOString();

    // Resolve the product (verified catalogue data only).
    let productId: string | null = null;
    let variantId: string | null = null;
    if (input.shopifyVariantId) {
      const variant = (await this.deps.products.listVariants(brandId)).find(
        (v) => v.shopifyVariantId === input.shopifyVariantId,
      );
      if (!variant) throw new AppError(404, 'UNKNOWN_VARIANT', 'This product is not known.');
      productId = variant.productId;
      variantId = variant.variantId;
    } else if (PRODUCT_EVENTS.includes(input.eventType)) {
      throw invalid('shopify_variant_id is required for this event.');
    }

    let searchTerm: string | null = null;
    let matchedCategory: string | null = null;
    if (input.eventType === 'SEARCH') {
      searchTerm = normalizeSearchTerm(input.searchTerm ?? '');
      if (!searchTerm) throw invalid('search_term is required for SEARCH.');
      if (looksLikePii(searchTerm)) throw invalid('search_term must not contain personal data.');
      const products = await this.deps.products.listProducts(brandId);
      matchedCategory = matchSearchCategory(searchTerm, {
        categories: [...new Set(products.map((p) => p.category).filter((c): c is string => !!c))],
        tags: [...new Set(products.flatMap((p) => p.tags))],
      });
    }
    if (input.eventType === 'WHATSAPP_CLICK' && !input.entry) throw invalid('entry is required for WHATSAPP_CLICK.');

    const visitorHash = input.visitorId ? visitorHashOf(input.visitorId) : null;
    const link = visitorHash ? await this.deps.visitors.get(brandId, visitorHash) : null;
    const intentId = intentIdFor(brandId, input.webSessionId);

    let replay = false;
    const intent = await this.deps.intents.update(brandId, intentId, (current) => {
      if (current?.processedEventIds.includes(input.clientEventId)) {
        replay = true;
        return null;
      }
      const classified = applyWebEvent(current ? toClassification(current) : null, {
        type: input.eventType,
        productId,
        variantId,
        matchedCategory,
        entry: input.entry,
        at,
      });
      return {
        intentId,
        brandId,
        customerId: current?.customerId ?? link?.customerId ?? null,
        webSessionId: input.webSessionId,
        visitorHash: current?.visitorHash ?? visitorHash,
        source: 'WEBSITE',
        stage: classified.stage,
        strength: classified.strength,
        type: classified.type,
        confidence: 1,
        productId: classified.productId,
        variantId: classified.variantId,
        matchedCategory: classified.matchedCategory,
        signals: classified.signals,
        lastEvent: classified.lastEvent,
        lastEventAt: classified.lastEventAt,
        eventCount: classified.eventCount,
        detectedAt: current?.detectedAt ?? at,
        updatedAt: at,
        // New activity revives an abandoned session; a converted one stays converted.
        status: current?.status === 'CONVERTED' ? 'CONVERTED' : 'ACTIVE',
        tokenConsumedAt: current?.tokenConsumedAt ?? null,
        followUp: current?.followUp ?? null,
        processedEventIds: [...(current?.processedEventIds ?? []), input.clientEventId].slice(-MAX_PROCESSED_IDS),
      };
    });
    const stored = intent ?? (await this.deps.intents.get(brandId, intentId))!;

    await this.deps.events.record({
      brandId,
      eventType: input.eventType,
      source: 'WEBSITE',
      customerId: stored.customerId,
      webSessionId: input.webSessionId,
      entityReference: variantId ?? productId,
      payload: {
        product_id: productId,
        variant_id: variantId,
        matched_category: matchedCategory,
        search_term: searchTerm,
        entry: input.entry,
      },
      idempotencyKey: `${input.webSessionId}:${input.clientEventId}`,
      at,
    });

    if (replay) return { accepted: true, replay, intent: stored, whatsapp: null };
    await this.deps.events.audit(brandId, {
      action: 'INTENT_EVENT_RECORDED',
      targetType: 'INTENT',
      targetId: intentId,
      reasonCode: input.eventType,
      actor: { type: 'SYSTEM', id: 'storefront' },
    });

    const whatsapp = input.eventType === 'WHATSAPP_CLICK' ? await this.issueToken(brand, stored, now) : null;
    await this.deps.onIntentUpdated?.(stored);
    return { accepted: true, replay, intent: (await this.deps.intents.get(brandId, intentId)) ?? stored, whatsapp };
  }

  private async issueToken(brand: BrandRecord, intent: IntentRecord, now: Date) {
    const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    if (
      (await this.deps.tokens.countIssuedSince(brand.brandId, intent.webSessionId, since)) >=
      MAX_TOKENS_PER_SESSION_PER_HOUR
    ) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', true);
    }
    const token = encodeIntentToken(randomBytes(16));
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS).toISOString();
    await this.deps.tokens.create({
      tokenHash: hashIntentToken(token),
      brandId: brand.brandId,
      intentId: intent.intentId,
      webSessionId: intent.webSessionId,
      issuedAt: now.toISOString(),
      expiresAt,
      consumedAt: null,
      consumedByCustomerId: null,
    });
    const text = prefilledText(token);
    const number = resolveMessagingSettings(brand.settings, brand.name).whatsappNumber;
    return { prefilledText: text, waLink: number ? `https://wa.me/${number}?text=${text}` : null, expiresAt };
  }
}

const invalid = (message: string) => new AppError(400, 'INVALID_EVENT', message);

function toClassification(r: IntentRecord): IntentClassification {
  return {
    stage: r.stage,
    strength: r.strength,
    type: r.type,
    productId: r.productId,
    variantId: r.variantId,
    matchedCategory: r.matchedCategory,
    signals: r.signals,
    lastEvent: r.lastEvent,
    lastEventAt: r.lastEventAt,
    eventCount: r.eventCount,
  };
}
