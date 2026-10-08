import { mapCatalogVariants } from '../domain/skuMapping.js';
import { AppError } from '../lib/errors.js';
import type { CommerceProduct, CommerceProvider } from '../ports/commerce.js';
import { ShopifyApiError } from '../ports/shopify.js';
import type { CommerceProviderResolver } from './shopifyConnections.js';
import type {
  AuditRepository,
  ConnectionRecord,
  ConnectionRepository,
  MappingRecord,
  MappingRepository,
  ProductRecord,
  ProductRepository,
  VariantRecord,
} from '../ports/repositories.js';

export interface CommerceSyncDeps {
  /** The one provider for every brand (mock wiring and tests). */
  commerce?: CommerceProvider;
  /** L2-Shopify: the brand's own provider (Shopify mode); takes precedence over `commerce`. */
  resolver?: CommerceProviderResolver;
  products: ProductRepository;
  mappings: MappingRepository;
  connections: ConnectionRepository;
  audit: AuditRepository;
  now?: () => Date;
}

/** Who triggered the sync, for the audit trail. */
export interface SyncActor {
  type: 'USER' | 'SYSTEM';
  id: string;
}

export const SHOPIFY_CONNECTION_ID = 'SHOPIFY';

/** Deterministic Qwikspot IDs from provider IDs, so a re-sync overwrites instead of duplicating. */
const idTail = (externalId: string) => (externalId.split('/').pop() ?? externalId).replace(/[^A-Za-z0-9_-]/g, '_');
export const productIdFor = (externalProductId: string) => `prd_${idTail(externalProductId)}`;
export const variantIdFor = (externalVariantId: string) => `var_${idTail(externalVariantId)}`;

/**
 * Catalogue sync (docs/06_INTEGRATION_CONTRACTS.md §8): CommerceProvider → normalizer →
 * brands/{brand_id}/products, productVariants, productMappings (source SHOPIFY), plus the
 * brand's SHOPIFY IntegrationConnection status. Customers and orders are not synced in M3.
 * Runs against the brand's CommerceProvider: the mock locally, or (L2-Shopify) the brand's
 * connected Shopify store. A Shopify sync archives the brand's products that the store no
 * longer has — e.g. the mock catalogue a demo brand was seeded with — so SKUs never conflict.
 */
export class CommerceSyncService {
  private readonly now: () => Date;

  constructor(private readonly deps: CommerceSyncDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private provider(brandId: string): Promise<CommerceProvider> {
    if (this.deps.resolver) return this.deps.resolver.forBrand(brandId);
    if (!this.deps.commerce) throw new Error('CommerceSyncService needs a provider');
    return Promise.resolve(this.deps.commerce);
  }

  async sync(brandId: string, actor: SyncActor): Promise<ConnectionRecord> {
    const commerce = await this.provider(brandId); // 409 SHOPIFY_NOT_CONNECTED when there is no store
    const shop = (await this.deps.resolver?.shopInfo(brandId)) ?? null;
    const previous = await this.deps.connections.get(brandId, SHOPIFY_CONNECTION_ID);
    const at = this.now().toISOString();
    const base = { ...(previous ?? this.emptyConnection(brandId)), source: commerce.name };
    if (shop) Object.assign(base, { shopDomain: shop.shopDomain, shopName: shop.shopName });

    let source: CommerceProduct[];
    try {
      source = await commerce.getProducts();
    } catch (err) {
      // Normalized, safe error (docs/06 §16): never the provider's raw message or credentials.
      const unauthorized = err instanceof ShopifyApiError && err.kind === 'UNAUTHORIZED';
      if (err instanceof AppError) throw err; // e.g. reconnect required (already recorded)
      await this.deps.connections.put({
        ...base,
        status: 'ERROR',
        lastError: unauthorized
          ? { code: 'SHOPIFY_RECONNECT_REQUIRED', message: 'Shopify no longer accepts this connection.' }
          : { code: 'COMMERCE_SYNC_FAILED', message: 'The commerce provider could not be reached.' },
      });
      if (unauthorized) {
        throw new AppError(
          409,
          'SHOPIFY_RECONNECT_REQUIRED',
          'Shopify no longer accepts this connection. Reconnect Shopify.',
        );
      }
      throw new AppError(502, 'COMMERCE_SYNC_FAILED', 'The catalogue could not be synced. Try again.', true);
    }

    const products: ProductRecord[] = [];
    const variants: VariantRecord[] = [];
    for (const p of source) {
      const productId = productIdFor(p.externalProductId);
      products.push({
        productId,
        brandId,
        canonicalProductId: productId,
        shopifyProductId: p.externalProductId,
        title: p.title,
        description: p.description,
        category: p.category,
        status: p.status,
        tags: [...p.tags],
        attributes: { ...p.attributes },
        imageUrl: p.imageUrl ?? null,
        handle: p.handle ?? null,
      });
      for (const v of p.variants) {
        variants.push({
          variantId: variantIdFor(v.externalVariantId),
          brandId,
          productId,
          shopifyVariantId: v.externalVariantId,
          title: v.title,
          sku: v.sku,
          canonicalSku: null, // set from the mapping decision below
          barcode: v.barcode,
          price: v.price,
          currency: v.currency,
          status: v.status,
        });
      }
    }

    const decisions = mapCatalogVariants(variants.map((v) => ({ variantId: v.variantId, sku: v.sku })));
    const mappings: MappingRecord[] = variants.map((v) => {
      const d = decisions.get(v.variantId)!;
      v.canonicalSku = d.status === 'AUTO_MATCHED' ? d.canonicalSku : null;
      return {
        mappingId: `shp_${v.variantId}`,
        brandId,
        sourceSystem: 'SHOPIFY',
        sourceIdentifier: v.shopifyVariantId,
        canonicalSku: d.canonicalSku,
        variantId: v.variantId,
        mappingStatus: d.status,
        mappingReason: d.reason,
        updatedAt: null,
      };
    });

    // A Shopify store is the catalogue: what it no longer has (or never had — a seeded mock
    // catalogue) is archived, its SKU released so retail stock maps to the live variants.
    const archived = commerce.name === 'SHOPIFY' ? await this.staleCatalog(brandId, products, variants) : null;

    await this.deps.products.upsertCatalog(
      brandId,
      [...products, ...(archived?.products ?? [])],
      [...variants, ...(archived?.variants ?? [])],
    );
    await this.deps.mappings.upsertMany(brandId, [...mappings, ...(archived?.mappings ?? [])]);

    const connection: ConnectionRecord = {
      ...base,
      status: 'CONNECTED',
      connectedAt: previous?.connectedAt ?? at,
      lastSyncAt: at,
      lastError: null,
      productCount: products.length,
      variantCount: variants.length,
    };
    await this.deps.connections.put(connection);
    await this.deps.audit.recordBrandEvent({
      brandId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'CATALOG_SYNCED',
      targetType: 'CONNECTION',
      targetId: SHOPIFY_CONNECTION_ID,
      result: 'SUCCESS',
      reasonCode: null,
    });
    return connection;
  }

  private async staleCatalog(brandId: string, products: ProductRecord[], variants: VariantRecord[]) {
    const keepProducts = new Set(products.map((p) => p.productId));
    const keepVariants = new Set(variants.map((v) => v.variantId));
    const staleProducts = (await this.deps.products.listProducts(brandId))
      .filter((p) => !keepProducts.has(p.productId) && p.status !== 'ARCHIVED')
      .map((p) => ({ ...p, status: 'ARCHIVED' }));
    const staleVariants = (await this.deps.products.listVariants(brandId))
      .filter((v) => !keepVariants.has(v.variantId) && (v.status !== 'ARCHIVED' || v.canonicalSku !== null))
      .map((v): VariantRecord => ({ ...v, status: 'ARCHIVED', canonicalSku: null }));
    const staleMappings: MappingRecord[] = staleVariants.map((v) => ({
      mappingId: `shp_${v.variantId}`,
      brandId,
      sourceSystem: 'SHOPIFY',
      sourceIdentifier: v.shopifyVariantId,
      canonicalSku: null,
      variantId: v.variantId,
      mappingStatus: 'UNMAPPED',
      mappingReason: 'NOT_IN_SOURCE',
      updatedAt: null,
    }));
    return { products: staleProducts, variants: staleVariants, mappings: staleMappings };
  }

  listConnections(brandId: string): Promise<ConnectionRecord[]> {
    return this.deps.connections.list(brandId);
  }

  private emptyConnection(brandId: string): ConnectionRecord {
    return {
      connectionId: SHOPIFY_CONNECTION_ID,
      brandId,
      provider: 'SHOPIFY',
      source: this.deps.commerce?.name ?? 'SHOPIFY',
      status: 'ERROR',
      connectedAt: null,
      lastSyncAt: null,
      lastError: null,
      productCount: 0,
      variantCount: 0,
    };
  }
}
