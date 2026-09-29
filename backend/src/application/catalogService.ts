import type {
  InventoryRepository,
  MappingRecord,
  MappingRepository,
  ProductRecord,
  ProductRepository,
  VariantRecord,
} from '../ports/repositories.js';

export interface CatalogVariantView extends VariantRecord {
  /** Catalogue-side SKU mapping (source SHOPIFY). */
  mappingStatus: MappingRecord['mappingStatus'] | null;
  mappingReason: string | null;
  /** Stores holding an inventory record for this variant. */
  storesStocked: number;
}

export interface CatalogView {
  products: (ProductRecord & { variants: CatalogVariantView[] })[];
  /** Retail-file SKUs that did not auto-match: they stay visible until fixed. */
  retailMappingsNeedingAttention: MappingRecord[];
  mappingSummary: { autoMatched: number; needsAttention: number };
}

/** Brand Console catalogue view (M3): products → variants → mapping status. */
export class CatalogService {
  constructor(
    private readonly deps: { products: ProductRepository; mappings: MappingRepository; inventory: InventoryRepository },
  ) {}

  async catalog(brandId: string): Promise<CatalogView> {
    const [products, variants, mappings, inventory] = await Promise.all([
      this.deps.products.listProducts(brandId),
      this.deps.products.listVariants(brandId),
      this.deps.mappings.list(brandId),
      this.deps.inventory.listByBrand(brandId),
    ]);
    const shopify = new Map(mappings.filter((m) => m.sourceSystem === 'SHOPIFY').map((m) => [m.variantId, m]));
    const stocked = new Map<string, number>();
    for (const row of inventory) stocked.set(row.variantId, (stocked.get(row.variantId) ?? 0) + 1);

    const byProduct = new Map<string, CatalogVariantView[]>();
    for (const v of variants) {
      const m = shopify.get(v.variantId);
      byProduct.set(v.productId, [
        ...(byProduct.get(v.productId) ?? []),
        {
          ...v,
          mappingStatus: m?.mappingStatus ?? null,
          mappingReason: m?.mappingReason ?? null,
          storesStocked: stocked.get(v.variantId) ?? 0,
        },
      ]);
    }

    return {
      products: products
        .map((p) => ({ ...p, variants: (byProduct.get(p.productId) ?? []).sort((a, b) => a.sku.localeCompare(b.sku)) }))
        .sort((a, b) => a.title.localeCompare(b.title)),
      retailMappingsNeedingAttention: mappings
        .filter((m) => m.sourceSystem === 'RETAIL_FILE' && m.mappingStatus !== 'AUTO_MATCHED')
        .sort((a, b) => a.sourceIdentifier.localeCompare(b.sourceIdentifier)),
      mappingSummary: {
        autoMatched: mappings.filter((m) => m.mappingStatus === 'AUTO_MATCHED').length,
        needsAttention: mappings.filter((m) => m.mappingStatus !== 'AUTO_MATCHED').length,
      },
    };
  }
}
