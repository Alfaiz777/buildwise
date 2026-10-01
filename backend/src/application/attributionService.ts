import {
  ATTRIBUTION_REF_PATTERN,
  checkAttributionRef,
  decorateOnlineLinks,
  hashAttributionRef,
  newAttributionRef,
  onlinePrefixOf,
} from '../domain/attributionRef.js';
import { attributionWindowMs } from '../domain/outcomeRules.js';
import type { AttributionRefRecord, AttributionRefRepository } from '../ports/outcomes.js';
import type { BrandRepository } from '../ports/repositories.js';

export interface JourneyLink {
  intentId: string | null;
  conversationId: string | null;
  recommendationId: string | null;
}

/**
 * Online-order attribution (docs/00 §11.8 Change 13, F6). `bw_ref` only LINKS an order to
 * a journey; the order from the commerce source is the evidence. The raw ref exists only
 * in the link the customer receives; Buildwise stores its hash.
 */
export class AttributionService {
  constructor(private readonly deps: { refs: AttributionRefRepository; brands: BrandRepository; now: () => Date }) {}

  /** Adds a fresh bw_ref to every brand online-store link in `text` (one ref per message). */
  async decorate(brandId: string, text: string, link: JourneyLink): Promise<string> {
    const brand = await this.deps.brands.getById(brandId);
    const prefix = brand ? onlinePrefixOf(brand.settings) : null;
    if (!brand || !prefix || !text.includes(prefix)) return text;
    const ref = newAttributionRef();
    const now = this.deps.now();
    await this.deps.refs.create({
      refHash: hashAttributionRef(ref),
      brandId,
      ...link,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + attributionWindowMs(brand.settings)).toISOString(),
    });
    return decorateOnlineLinks(text, prefix, ref);
  }

  /** Valid → the journey link; malformed, unknown, other-brand or expired → null (the order stays unattributed). */
  async resolve(brandId: string, ref: string | null | undefined): Promise<AttributionRefRecord | null> {
    if (!ref || !ATTRIBUTION_REF_PATTERN.test(ref)) return null;
    const stored = await this.deps.refs.get(brandId, hashAttributionRef(ref));
    return checkAttributionRef(stored, brandId, this.deps.now()) ? null : stored;
  }
}
