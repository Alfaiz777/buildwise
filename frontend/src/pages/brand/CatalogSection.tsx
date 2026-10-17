import { RefreshCw } from 'lucide-react';
import { Badge, Button, Card, ProductThumb } from '../../components/ui';
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

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  AUTO_MATCHED: 'success',
  MANUAL_MATCH_REQUIRED: 'warning',
  CONFLICT: 'danger',
  UNMAPPED: 'neutral',
};

/**
 * Catalogue & mapping (UI-P3 layout): a sync status card with "Sync now", the products as a grid
 * of cards (thumbnail, variants with SKU, price, mapping and stores stocked), and the retail SKUs
 * that did not match. Same data and actions as before.
 */
export function CatalogSection(props: {
  catalog: CatalogResponse | null;
  error: string | null;
  syncing: boolean;
  onSync: () => void;
}) {
  const { catalog } = props;
  const variants = catalog?.products.reduce((n, p) => n + p.variants.length, 0) ?? 0;
  return (
    <Card title="Catalog & mapping" id="catalog" description="Your products, as your commerce store has them.">
      {props.error && <p className="error">{props.error}</p>}
      <div className="nw-sync">
        <div className="nw-sync__facts">
          <span>
            <strong>{catalog?.products.length ?? '—'}</strong> products
          </span>
          <span>
            <strong>{catalog ? variants : '—'}</strong> variants
          </span>
          <span>
            <strong>{catalog?.mapping_summary.auto_matched ?? '—'}</strong> retail SKUs matched
          </span>
          <span className={catalog?.mapping_summary.needs_attention ? 'nw-sync__warn' : undefined}>
            <strong>{catalog?.mapping_summary.needs_attention ?? '—'}</strong> need attention
          </span>
        </div>
        <Button
          variant="brand"
          size="sm"
          loading={props.syncing}
          icon={<RefreshCw size={16} aria-hidden="true" />}
          onClick={props.onSync}
        >
          {props.syncing ? 'Syncing…' : 'Sync catalog'}
        </Button>
      </div>
      {catalog && catalog.products.length === 0 ? (
        <p className="muted">No products yet. Sync the catalog from your commerce store.</p>
      ) : (
        <ul className="nw-products" aria-label="Products">
          {catalog?.products.map((p) => (
            <li key={p.product_id ?? p.title}>
              <article className="nw-product" aria-label={p.title}>
                <header className="nw-product__head">
                  <ProductThumb src={p.image_url ?? null} name={p.title} size={48} />
                  <strong>{p.title}</strong>
                </header>
                <table className="nw-product__variants">
                  <thead className="sr-only">
                    <tr>
                      <th>Variant</th>
                      <th>SKU</th>
                      <th>Price</th>
                      <th>Mapping</th>
                      <th>Stores</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.variants.map((v) => (
                      <tr key={v.variant_id}>
                        <td>{v.title}</td>
                        <td className="mono small">{v.sku}</td>
                        <td>{formatPrice(v.price, v.currency)}</td>
                        <td>
                          {v.mapping_status ? (
                            <Badge tone={STATUS_TONE[v.mapping_status] ?? 'neutral'}>
                              {STATUS_LABEL[v.mapping_status]}
                            </Badge>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="small muted">
                          {v.stores_stocked} <span className="sr-only">stores stocked</span>
                          <span aria-hidden="true"> stores</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            </li>
          ))}
        </ul>
      )}
      {!!catalog?.retail_mappings_needing_attention.length && (
        <>
          <h3>Retail SKUs needing attention</h3>
          <p className="muted small">
            These SKUs from retail files did not match the catalog automatically; their stock is not used until fixed.
          </p>
          <div className="ui-table-wrap">
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
                    <td>
                      <Badge tone={STATUS_TONE[m.mapping_status] ?? 'neutral'}>{STATUS_LABEL[m.mapping_status]}</Badge>
                    </td>
                    <td className="small">{mappingReason(m.mapping_reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
