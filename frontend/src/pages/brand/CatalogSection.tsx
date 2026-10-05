import { Section } from '../../components/ConsoleShell';
import { ProductThumb } from '../../components/ui';
import { formatPrice, type CatalogResponse } from './types';

const STATUS_LABEL: Record<string, string> = {
  AUTO_MATCHED: 'Matched',
  MANUAL_MATCH_REQUIRED: 'Needs review',
  CONFLICT: 'Conflict',
  UNMAPPED: 'Not matched',
};

/** Why a retail SKU did not match, in words (domain/skuMapping.ts reasons). */
export function mappingReason(reason: string): string {
  if (reason.startsWith('NEAR_MATCH:')) return `Looks like ${reason.slice(11)} — confirm before its stock is used`;
  const words: Record<string, string> = {
    NO_CATALOG_MATCH: 'No product in your catalogue has this SKU',
    MISSING_OR_INVALID_SKU: 'The SKU is missing or invalid',
    DUPLICATE_CATALOG_SKU: 'Two catalogue variants share this SKU',
    DUPLICATE_CATALOG_BARCODE: 'Two catalogue variants share this barcode',
    SKU_AND_BARCODE_DISAGREE: 'The SKU and the barcode point to different products',
    BARCODE_MATCH_WITHOUT_CATALOG_SKU: 'The barcode matches a variant that has no SKU',
    AMBIGUOUS_NEAR_MATCH: 'Close to more than one catalogue SKU',
  };
  return words[reason] ?? reason.toLowerCase().replace(/_/g, ' ');
}

/** Catalogue & mapping: products → variants (SKU, price, mapping status), plus retail SKUs to fix. */
export function CatalogSection(props: {
  catalog: CatalogResponse | null;
  error: string | null;
  syncing: boolean;
  onSync: () => void;
}) {
  const { catalog } = props;
  return (
    <Section title="Catalog & mapping" id="catalog">
      {props.error && <p className="error">{props.error}</p>}
      <button type="button" className="secondary" onClick={props.onSync} disabled={props.syncing}>
        {props.syncing ? 'Syncing…' : 'Sync catalog'}
      </button>
      {catalog && catalog.products.length === 0 ? (
        <p className="muted">No products yet. Sync the catalog from your commerce store.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Variant</th>
              <th>SKU</th>
              <th>Price</th>
              <th>Mapping</th>
              <th>Stores</th>
            </tr>
          </thead>
          <tbody>
            {catalog?.products.flatMap((p) =>
              p.variants.map((v, i) => (
                <tr key={v.variant_id}>
                  <td>
                    {i === 0 && (
                      <span className="cell-product">
                        <ProductThumb src={p.image_url ?? null} name={p.title} size={36} />
                        {p.title}
                      </span>
                    )}
                  </td>
                  <td>{v.title}</td>
                  <td className="mono">{v.sku}</td>
                  <td>{formatPrice(v.price, v.currency)}</td>
                  <td>{v.mapping_status ? STATUS_LABEL[v.mapping_status] : '—'}</td>
                  <td>{v.stores_stocked}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
      {!!catalog?.retail_mappings_needing_attention.length && (
        <>
          <h3>Retail SKUs needing attention</h3>
          <p className="muted small">
            These SKUs from retail files did not match the catalog automatically; their stock is not used until fixed.
          </p>
          <table>
            <thead>
              <tr>
                <th>Retail SKU</th>
                <th>Status</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {catalog.retail_mappings_needing_attention.map((m) => (
                <tr key={m.source_identifier}>
                  <td className="mono">{m.source_identifier}</td>
                  <td>{STATUS_LABEL[m.mapping_status]}</td>
                  <td className="small">{mappingReason(m.mapping_reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}
