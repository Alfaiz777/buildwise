/**
 * CommerceProvider port (docs/06_INTEGRATION_CONTRACTS.md §2).
 * Normalized, provider-neutral shapes: no Shopify GraphQL shapes leak past the adapter.
 * IDs keep the source system's format (Shopify GIDs) in both adapters.
 * M3 (commerce sync) may extend these shapes; the method set is canonical.
 */

export interface CommerceVariant {
  externalVariantId: string;
  externalProductId: string;
  sku: string;
  barcode: string | null;
  title: string;
  price: number;
  currency: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
}

export interface CommerceProduct {
  externalProductId: string;
  title: string;
  description: string;
  category: string | null;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  variants: CommerceVariant[];
}

export interface CommerceCustomer {
  externalCustomerId: string;
  /** Minimum necessary: no address, no payment data. */
  firstName: string | null;
  email: string | null;
  phone: string | null;
}

export interface CommerceOrderLine {
  externalVariantId: string;
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface CommerceOrder {
  externalOrderId: string;
  externalCustomerId: string | null;
  lines: CommerceOrderLine[];
  totalPrice: number;
  currency: string;
  /** ISO-8601 */
  createdAt: string;
}

export interface CommerceLocation {
  externalLocationId: string;
  name: string;
}

export interface CommerceInventoryLevel {
  externalVariantId: string;
  externalLocationId: string;
  available: number;
}

export interface OrderQuery {
  externalCustomerId?: string;
  /** ISO-8601 lower bound on createdAt */
  createdAfter?: string;
}

export interface InventoryQuery {
  externalVariantIds?: string[];
}

export interface CommerceProvider {
  readonly name: 'MOCK' | 'SHOPIFY';
  getProducts(): Promise<CommerceProduct[]>;
  getProductVariant(externalVariantId: string): Promise<CommerceVariant | null>;
  getCustomer(externalCustomerId: string): Promise<CommerceCustomer | null>;
  getOrder(externalOrderId: string): Promise<CommerceOrder | null>;
  getOrders(query: OrderQuery): Promise<CommerceOrder[]>;
  getInventory(query: InventoryQuery): Promise<CommerceInventoryLevel[]>;
  getLocations(): Promise<CommerceLocation[]>;
}
