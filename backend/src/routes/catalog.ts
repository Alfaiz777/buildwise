import { Router } from 'express';
import type { CatalogService } from '../application/catalogService.js';
import type { CommerceSyncService } from '../application/commerceSyncService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import type { ConnectionRecord } from '../ports/repositories.js';

/**
 * Catalogue routes for the brand's BRAND_ADMIN (docs/06_INTEGRATION_CONTRACTS.md §14).
 * Mounted behind requireScope('BRAND'); the brand always comes from the principal.
 */

export const connectionJson = (c: ConnectionRecord) => ({
  connection_id: c.connectionId,
  provider: c.provider,
  source: c.source,
  status: c.status,
  shop_domain: c.shopDomain ?? null,
  shop_name: c.shopName ?? null,
  connected_at: c.connectedAt,
  last_sync_at: c.lastSyncAt,
  last_error: c.lastError,
  product_count: c.productCount,
  variant_count: c.variantCount,
});

/** POST /api/integrations/shopify/sync: runs the sync with the wired CommerceProvider. */
export function integrationsRouter(sync: CommerceSyncService): Router {
  const router = Router();
  router.post('/shopify/sync', async (_req, res) => {
    const principal = getBrandPrincipal(res);
    const connection = await sync.sync(principal.brandId, { type: 'USER', id: principal.userId });
    res.json(connectionJson(connection));
  });
  return router;
}

/** GET /api/products: products → variants with mapping status. */
export function productsRouter(catalog: CatalogService): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    const view = await catalog.catalog(getBrandPrincipal(res).brandId);
    res.json({
      products: view.products.map((p) => ({
        product_id: p.productId,
        shopify_product_id: p.shopifyProductId,
        title: p.title,
        description: p.description,
        category: p.category,
        image_url: p.imageUrl ?? null,
        status: p.status,
        tags: p.tags,
        attributes: p.attributes,
        variants: p.variants.map((v) => ({
          variant_id: v.variantId,
          shopify_variant_id: v.shopifyVariantId,
          title: v.title,
          sku: v.sku,
          canonical_sku: v.canonicalSku,
          barcode: v.barcode,
          price: v.price,
          currency: v.currency,
          status: v.status,
          mapping_status: v.mappingStatus,
          mapping_reason: v.mappingReason,
          stores_stocked: v.storesStocked,
        })),
      })),
      retail_mappings_needing_attention: view.retailMappingsNeedingAttention.map((m) => ({
        source_identifier: m.sourceIdentifier,
        mapping_status: m.mappingStatus,
        mapping_reason: m.mappingReason,
        suggested_variant_id: m.variantId,
        updated_at: m.updatedAt,
      })),
      mapping_summary: {
        auto_matched: view.mappingSummary.autoMatched,
        needs_attention: view.mappingSummary.needsAttention,
      },
    });
  });
  return router;
}

/** GET /api/brand/connections: integration status only, never credentials. */
export function connectionsRouter(sync: CommerceSyncService): Router {
  const router = Router();
  router.get('/connections', async (_req, res) => {
    const connections = await sync.listConnections(getBrandPrincipal(res).brandId);
    res.json({ connections: connections.map(connectionJson) });
  });
  return router;
}
