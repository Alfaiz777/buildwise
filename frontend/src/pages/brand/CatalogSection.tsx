import { Section } from '../../components/ConsoleShell';
import { formatPrice, type CatalogResponse } from './types';

const STATUS_LABEL: Record<string, string> = {
  AUTO_MATCHED: 'auto-matched',
  MANUAL_MATCH_REQUIRED: 'needs review',
  CONFLICT: 'conflict',
  UNMAPPED: 'unmapped',
};

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
                  <td>{i === 0 ? p.title : ''}</td>
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
                  <td className="small mono">{m.mapping_reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}
