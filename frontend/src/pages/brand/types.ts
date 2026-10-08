/** Response shapes of the Brand Console routes (docs/06_INTEGRATION_CONTRACTS.md §14). */

export type MappingStatus = 'AUTO_MATCHED' | 'MANUAL_MATCH_REQUIRED' | 'CONFLICT' | 'UNMAPPED';

export interface Connection {
  connection_id: string;
  provider: string;
  source: string;
  status: 'CONNECTED' | 'ERROR' | 'DISCONNECTED';
  /** L2-Shopify: the connected store (status only, never a credential). */
  shop_domain?: string | null;
  shop_name?: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_error: { code: string; message: string } | null;
  product_count: number;
  variant_count: number;
}

export interface CatalogVariant {
  variant_id: string;
  title: string;
  sku: string;
  canonical_sku: string | null;
  price: number;
  currency: string;
  mapping_status: MappingStatus | null;
  stores_stocked: number;
}

export interface CatalogProduct {
  product_id: string;
  title: string;
  category: string | null;
  /** Change 16: the product image (relative path or https URL). */
  image_url?: string | null;
  tags: string[];
  variants: CatalogVariant[];
}

export interface RetailMappingIssue {
  source_identifier: string;
  mapping_status: MappingStatus;
  mapping_reason: string;
}

export interface CatalogResponse {
  products: CatalogProduct[];
  retail_mappings_needing_attention: RetailMappingIssue[];
  mapping_summary: { auto_matched: number; needs_attention: number };
}

export interface RetailImport {
  import_id: string;
  file_name: string;
  status: 'UPLOADED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  failure_code: string | null;
  rows_processed: number;
  rows_valid: number;
  rows_invalid: number;
  mappings_created: number;
  mappings_failed: number;
  created_at: string | null;
  completed_at: string | null;
}

export interface RowError {
  line: number;
  store_id: string | null;
  sku: string | null;
  code: string;
  field: string | null;
  message: string;
}

export interface RetailImportReport extends RetailImport {
  row_errors: RowError[];
}

export interface BrandStore {
  store_id: string;
  store_name: string;
  city: string;
  store_status: string;
  retailer_id: string | null;
  retail_admin_user_id: string | null;
  sku_count: number;
  stock_updated_at: string | null;
}

/** "5 Oct 2026, 12:30 pm" in the viewer's locale; "—" when absent. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatPrice(amount: number, currency: string): string {
  return currency === 'INR' ? `₹${amount.toLocaleString('en-IN')}` : `${amount} ${currency}`;
}
