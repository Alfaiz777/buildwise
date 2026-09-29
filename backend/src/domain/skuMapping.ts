/**
 * SKU identity (docs/04_DATA_MODEL.md §8.1, §19; docs/06_INTEGRATION_CONTRACTS.md §13):
 *
 *   Shopify variant SKU  ↔  canonical SKU  ↔  retail SKU
 *
 * Matching is by SKU first, then barcode — never by product name.
 */
export type MappingStatus = 'AUTO_MATCHED' | 'MANUAL_MATCH_REQUIRED' | 'CONFLICT' | 'UNMAPPED';

const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;

/** Trimmed and upper-cased; null when the value cannot be a SKU. */
export function normalizeSku(raw: string | null | undefined): string | null {
  const sku = (raw ?? '').trim().toUpperCase();
  return SKU_PATTERN.test(sku) ? sku : null;
}

/** Only for suggesting a near match; never used to auto-match. */
const loose = (sku: string) => sku.replace(/[._-]/g, '');

export interface CatalogVariantRef {
  variantId: string;
  /** Canonical SKU, or null when the catalogue SKU is unusable. */
  canonicalSku: string | null;
  barcode: string | null;
}

export interface MappingDecision {
  status: MappingStatus;
  /** The matched (or, for MANUAL_MATCH_REQUIRED, the suggested) variant. */
  variantId: string | null;
  canonicalSku: string | null;
  reason: string;
}

/** Maps one normalized retail SKU onto the catalogue. */
export function matchRetailSku(sku: string, variants: CatalogVariantRef[]): MappingDecision {
  const bySku = variants.filter((v) => v.canonicalSku === sku);
  const byBarcode = variants.filter((v) => v.barcode !== null && normalizeSku(v.barcode) === sku);

  if (bySku.length > 1) return conflict('DUPLICATE_CATALOG_SKU');
  if (bySku.length === 1) {
    if (byBarcode.some((v) => v.variantId !== bySku[0]!.variantId)) return conflict('SKU_AND_BARCODE_DISAGREE');
    return { status: 'AUTO_MATCHED', variantId: bySku[0]!.variantId, canonicalSku: sku, reason: 'SKU_EXACT' };
  }
  if (byBarcode.length > 1) return conflict('DUPLICATE_CATALOG_BARCODE');
  if (byBarcode.length === 1) {
    const variant = byBarcode[0]!;
    return variant.canonicalSku
      ? { status: 'AUTO_MATCHED', variantId: variant.variantId, canonicalSku: variant.canonicalSku, reason: 'BARCODE' }
      : conflict('BARCODE_MATCH_WITHOUT_CATALOG_SKU');
  }

  const near = variants.filter((v) => v.canonicalSku !== null && loose(v.canonicalSku) === loose(sku));
  if (near.length > 1) return conflict('AMBIGUOUS_NEAR_MATCH');
  if (near.length === 1) {
    return {
      status: 'MANUAL_MATCH_REQUIRED',
      variantId: near[0]!.variantId,
      canonicalSku: null,
      reason: `NEAR_MATCH:${near[0]!.canonicalSku}`,
    };
  }
  return { status: 'UNMAPPED', variantId: null, canonicalSku: null, reason: 'NO_CATALOG_MATCH' };
}

function conflict(reason: string): MappingDecision {
  return { status: 'CONFLICT', variantId: null, canonicalSku: null, reason };
}

/**
 * Catalogue-side mapping of each variant's SKU to its canonical SKU:
 * unique usable SKU → AUTO_MATCHED; a SKU shared by several variants → CONFLICT;
 * empty or unusable SKU → UNMAPPED.
 */
export function mapCatalogVariants(
  variants: { variantId: string; sku: string }[],
): Map<string, { status: MappingStatus; canonicalSku: string | null; reason: string }> {
  const canonical = new Map(variants.map((v) => [v.variantId, normalizeSku(v.sku)]));
  const counts = new Map<string, number>();
  for (const sku of canonical.values()) if (sku) counts.set(sku, (counts.get(sku) ?? 0) + 1);

  type CatalogMapping = { status: MappingStatus; canonicalSku: string | null; reason: string };
  return new Map<string, CatalogMapping>(
    variants.map((v): [string, CatalogMapping] => {
      const sku = canonical.get(v.variantId) ?? null;
      if (!sku) return [v.variantId, { status: 'UNMAPPED', canonicalSku: null, reason: 'MISSING_OR_INVALID_SKU' }];
      if (counts.get(sku)! > 1)
        return [v.variantId, { status: 'CONFLICT', canonicalSku: sku, reason: 'DUPLICATE_CATALOG_SKU' }];
      return [v.variantId, { status: 'AUTO_MATCHED', canonicalSku: sku, reason: 'CATALOG_SKU' }];
    }),
  );
}
