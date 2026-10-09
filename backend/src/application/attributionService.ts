import {
  ATTRIBUTION_REF_PATTERN,
  checkAttributionRef,
  decorateOnlineLinks,
  hashAttributionRef,
  linksToOnlineStore,
  newAttributionRef,
  onlinePrefixOf,
  type OnlineLinkTargets,
} from '../domain/attributionRef.js';
import { attributionWindowMs } from '../domain/outcomeRules.js';
import type { AttributionRefRecord, AttributionRefRepository } from '../ports/outcomes.js';
import type { BrandRepository, ConnectionRepository } from '../ports/repositories.js';
import { SHOPIFY_CONNECTION_ID } from './commerceSyncService.js';

export interface JourneyLink {
  intentId: string | null;
  conversationId: string | null;
  recommendationId: string | null;
}

/**
 * Online-order attribution (docs/00 §11.8 Change 13, F6). `qs_ref` only LINKS an order to
 * a journey; the order from the commerce source is the evidence. The raw ref exists only
 * in the link the customer receives; Qwikspot stores its hash.
 */
export class AttributionService {
  constructor(
    private readonly deps: {
      refs: AttributionRefRepository;
      brands: BrandRepository;
      /** L2-Shopify: the connected store, whose cart links carry qs_ref as a cart attribute. */
      connections?: ConnectionRepository;
      now: () => Date;
    },
  ) {}

  /**
   * Adds a fresh qs_ref to every brand online-store link in `text` (one ref per message):
   * storefront links get `?qs_ref=`, the connected Shopify store's cart links `attributes[qs_ref]`.
   */
  async decorate(brandId: string, text: string, link: JourneyLink): Promise<string> {
    const brand = await this.deps.brands.getById(brandId);
    if (!brand) return text;
    const shopify = await this.deps.connections?.get(brandId, SHOPIFY_CONNECTION_ID);
    const targets: OnlineLinkTargets = {
      storefrontPrefix: onlinePrefixOf(brand.settings),
      shopifyShop: shopify?.status === 'CONNECTED' ? (shopify.shopDomain ?? null) : null,
    };
    if (!linksToOnlineStore(text, targets)) return text;
    const ref = newAttributionRef();
    const now = this.deps.now();
    await this.deps.refs.create({
      refHash: hashAttributionRef(ref),
      brandId,
      ...link,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + attributionWindowMs(brand.settings)).toISOString(),
    });
    return decorateOnlineLinks(text, targets, ref);
  }

  /** Valid → the journey link; malformed, unknown, other-brand or expired → null (the order stays unattributed). */
  async resolve(brandId: string, ref: string | null | undefined): Promise<AttributionRefRecord | null> {
    if (!ref || !ATTRIBUTION_REF_PATTERN.test(ref)) return null;
    const stored = await this.deps.refs.get(brandId, hashAttributionRef(ref));
    return checkAttributionRef(stored, brandId, this.deps.now()) ? null : stored;
  }
}
