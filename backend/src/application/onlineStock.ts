import type { Logger } from '../lib/logger.js';
import type { CommerceProviderResolver } from './shopifyConnections.js';

/** How long a live answer is reused: one conversation turn asks for the same variant several times. */
const DEFAULT_TTL_MS = 60_000;

/**
 * Live online stock for "Buy online" (L2-Shopify). Before Qwikspot offers the connected
 * store's cart link it asks Shopify whether the variant can be bought online now
 * (`availableForSale`). A sold-out variant is never offered; when Shopify cannot be asked
 * the answer is unknown (null) and the link stays — Shopify's own checkout still refuses
 * what it cannot sell. Definite answers are cached briefly per brand and variant.
 */
export class OnlineStockService {
  private readonly cache = new Map<string, { value: boolean; at: number }>();
  private readonly ttlMs: number;

  constructor(
    private readonly deps: {
      resolver: Pick<CommerceProviderResolver, 'forBrand'>;
      logger?: Logger;
      now?: () => Date;
      ttlMs?: number;
    },
  ) {
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  private now() {
    return (this.deps.now ?? (() => new Date()))().getTime();
  }

  /** True / false from the brand's store; null when unknown (store unreachable or variant unknown). */
  async canBuyOnline(brandId: string, externalVariantId: string): Promise<boolean | null> {
    const key = `${brandId}:${externalVariantId}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.value;
    try {
      const value = await (await this.deps.resolver.forBrand(brandId)).getOnlineAvailability(externalVariantId);
      if (value !== null) this.cache.set(key, { value, at: this.now() });
      return value;
    } catch (err) {
      this.deps.logger?.warn('shopify.online_stock_unknown', {
        brand_id: brandId,
        error_code: (err as { code?: string; kind?: string }).code ?? (err as { kind?: string }).kind ?? 'ERROR',
      });
      return null;
    }
  }
}
