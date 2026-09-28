import type {
  CommerceCustomer,
  CommerceInventoryLevel,
  CommerceLocation,
  CommerceOrder,
  CommerceProduct,
  CommerceProvider,
  CommerceVariant,
  InventoryQuery,
  OrderQuery,
} from '../../ports/commerce.js';

/**
 * Deterministic, synthetic commerce data for the local profile and tests.
 * M2 establishes the contract only; M3 grows this fixture into the demo catalog.
 * IDs use the Shopify GID format so the stored data model is identical in both profiles.
 */
export interface CommerceFixture {
  products: CommerceProduct[];
  customers: CommerceCustomer[];
  orders: CommerceOrder[];
  locations: CommerceLocation[];
  inventory: CommerceInventoryLevel[];
}

const gid = (type: string, id: number) => `gid://shopify/${type}/${id}`;

export const DEFAULT_COMMERCE_FIXTURE: CommerceFixture = {
  products: [
    {
      externalProductId: gid('Product', 1001),
      title: 'Hydrating Face Serum',
      description: 'Lightweight daily serum.',
      category: 'Skincare',
      status: 'ACTIVE',
      variants: [
        {
          externalVariantId: gid('ProductVariant', 2001),
          externalProductId: gid('Product', 1001),
          sku: 'SERUM-30ML',
          barcode: '8901000000011',
          title: '30 ml',
          price: 999,
          currency: 'INR',
          status: 'ACTIVE',
        },
        {
          externalVariantId: gid('ProductVariant', 2002),
          externalProductId: gid('Product', 1001),
          sku: 'SERUM-50ML',
          barcode: '8901000000028',
          title: '50 ml',
          price: 1499,
          currency: 'INR',
          status: 'ACTIVE',
        },
      ],
    },
  ],
  customers: [{ externalCustomerId: gid('Customer', 3001), firstName: 'Test', email: null, phone: null }],
  orders: [
    {
      externalOrderId: gid('Order', 4001),
      externalCustomerId: gid('Customer', 3001),
      lines: [{ externalVariantId: gid('ProductVariant', 2001), sku: 'SERUM-30ML', quantity: 1, unitPrice: 999 }],
      totalPrice: 999,
      currency: 'INR',
      createdAt: '2026-09-01T10:00:00.000Z',
    },
  ],
  locations: [{ externalLocationId: gid('Location', 5001), name: 'Online warehouse' }],
  inventory: [
    { externalVariantId: gid('ProductVariant', 2001), externalLocationId: gid('Location', 5001), available: 40 },
    { externalVariantId: gid('ProductVariant', 2002), externalLocationId: gid('Location', 5001), available: 12 },
  ],
};

/** Returns copies so callers can never mutate the fixture. */
const clone = <T>(value: T): T => structuredClone(value);

export class MockCommerceProvider implements CommerceProvider {
  readonly name = 'MOCK' as const;

  constructor(private readonly fixture: CommerceFixture = DEFAULT_COMMERCE_FIXTURE) {}

  async getProducts(): Promise<CommerceProduct[]> {
    return clone(this.fixture.products);
  }

  async getProductVariant(externalVariantId: string): Promise<CommerceVariant | null> {
    const variant = this.fixture.products
      .flatMap((p) => p.variants)
      .find((v) => v.externalVariantId === externalVariantId);
    return variant ? clone(variant) : null;
  }

  async getCustomer(externalCustomerId: string): Promise<CommerceCustomer | null> {
    const customer = this.fixture.customers.find((c) => c.externalCustomerId === externalCustomerId);
    return customer ? clone(customer) : null;
  }

  async getOrder(externalOrderId: string): Promise<CommerceOrder | null> {
    const order = this.fixture.orders.find((o) => o.externalOrderId === externalOrderId);
    return order ? clone(order) : null;
  }

  async getOrders(query: OrderQuery): Promise<CommerceOrder[]> {
    return clone(
      this.fixture.orders.filter(
        (o) =>
          (!query.externalCustomerId || o.externalCustomerId === query.externalCustomerId) &&
          (!query.createdAfter || o.createdAt > query.createdAfter),
      ),
    );
  }

  async getInventory(query: InventoryQuery): Promise<CommerceInventoryLevel[]> {
    const wanted = query.externalVariantIds ? new Set(query.externalVariantIds) : null;
    return clone(this.fixture.inventory.filter((level) => !wanted || wanted.has(level.externalVariantId)));
  }

  async getLocations(): Promise<CommerceLocation[]> {
    return clone(this.fixture.locations);
  }
}
