import { mapCatalogVariants } from '../domain/skuMapping.js';
import { AppError } from '../lib/errors.js';
import type { CommerceProduct, CommerceProvider } from '../ports/commerce.js';
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
  commerce: CommerceProvider;
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

/** Deterministic Buildwise IDs from provider IDs, so a re-sync overwrites instead of duplicating. */
const idTail = (externalId: string) => (externalId.split('/').pop() ?? externalId).replace(/[^A-Za-z0-9_-]/g, '_');
export const productIdFor = (externalProductId: string) => `prd_${idTail(externalProductId)}`;
export const variantIdFor = (externalVariantId: string) => `var_${idTail(externalVariantId)}`;

/**
 * Catalogue sync (docs/06_INTEGRATION_CONTRACTS.md §8): CommerceProvider → normalizer →
 * brands/{brand_id}/products, productVariants, productMappings (source SHOPIFY), plus the
 * brand's SHOPIFY IntegrationConnection status. Customers and orders are not synced in M3.
 * Runs against whichever CommerceProvider the composition root wired (mock locally).
 */
export class CommerceSyncService {
  private readonly now: () => Date;

  constructor(private readonly deps: CommerceSyncDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async sync(brandId: string, actor: SyncActor): Promise<ConnectionRecord> {
    const previous = await this.deps.connections.get(brandId, SHOPIFY_CONNECTION_ID);
    const at = this.now().toISOString();

    let source: CommerceProduct[];
    try {
      source = await this.deps.commerce.getProducts();
    } catch {
      // Normalized, safe error (docs/06 §16): never the provider's raw message or credentials.
      await this.deps.connections.put({
        ...(previous ?? this.emptyConnection(brandId)),
        status: 'ERROR',
        lastError: { code: 'COMMERCE_SYNC_FAILED', message: 'The commerce provider could not be reached.' },
      });
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

    await this.deps.products.upsertCatalog(brandId, products, variants);
    await this.deps.mappings.upsertMany(brandId, mappings);

    const connection: ConnectionRecord = {
      ...(previous ?? this.emptyConnection(brandId)),
      source: this.deps.commerce.name,
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

  listConnections(brandId: string): Promise<ConnectionRecord[]> {
    return this.deps.connections.list(brandId);
  }

  private emptyConnection(brandId: string): ConnectionRecord {
    return {
      connectionId: SHOPIFY_CONNECTION_ID,
      brandId,
      provider: 'SHOPIFY',
      source: this.deps.commerce.name,
      status: 'ERROR',
      connectedAt: null,
      lastSyncAt: null,
      lastError: null,
      productCount: 0,
      variantCount: 0,
    };
  }
}
