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
 * Deterministic, synthetic commerce data for the local profile and tests: the
 * "Demo Beauty Co" skincare catalogue. IDs use the Shopify GID format so the stored data
 * model is identical in both profiles. All names, SKUs and barcodes are invented.
 *
 * Demo relationships (via tags / attributes, used from M5 for grounded answers):
 * - comparable pair: Vitamin C Glow Serum ↔ Niacinamide Clarifying Serum
 * - one alternative per hero product (same `concern`):
 *     Vitamin C Glow Serum      → Niacinamide Clarifying Serum
 *     Ceramide Barrier Cream    → Oil-Free Gel Moisturiser
 *     Mineral Sunscreen SPF 50  → Ultra-Light Gel Sunscreen SPF 50
 *     Gentle Foaming Cleanser   → Salicylic Clear Cleanser
 */
export interface CommerceFixture {
  products: CommerceProduct[];
  customers: CommerceCustomer[];
  orders: CommerceOrder[];
  locations: CommerceLocation[];
  inventory: CommerceInventoryLevel[];
}

const gid = (type: string, id: number) => `gid://shopify/${type}/${id}`;

interface VariantSeed {
  id: number;
  sku: string;
  barcode: string;
  title: string;
  price: number;
}

function product(
  id: number,
  title: string,
  description: string,
  category: string,
  tags: string[],
  attributes: Record<string, string>,
  variants: VariantSeed[],
): CommerceProduct {
  return {
    externalProductId: gid('Product', id),
    title,
    description,
    category,
    status: 'ACTIVE',
    tags,
    attributes,
    variants: variants.map((v) => ({
      externalVariantId: gid('ProductVariant', v.id),
      externalProductId: gid('Product', id),
      sku: v.sku,
      barcode: v.barcode,
      title: v.title,
      price: v.price,
      currency: 'INR',
      status: 'ACTIVE',
    })),
  };
}

export const DEFAULT_COMMERCE_FIXTURE: CommerceFixture = {
  products: [
    product(
      1001,
      'Vitamin C Glow Serum',
      '10% vitamin C serum for dull, uneven skin. Lightweight, absorbs fast.',
      'Serum',
      ['serum', 'hero', 'brightening', 'vitamin-c'],
      {
        concern: 'dullness',
        skin_type: 'all',
        key_ingredients: 'vitamin C, ferulic acid',
        texture: 'water-light',
        usage: 'morning',
      },
      [
        { id: 2001, sku: 'DBC-VCSERUM-30', barcode: '8906123000014', title: '30 ml', price: 795 },
        { id: 2002, sku: 'DBC-VCSERUM-50', barcode: '8906123000021', title: '50 ml', price: 1195 },
      ],
    ),
    product(
      1002,
      'Niacinamide Clarifying Serum',
      '5% niacinamide serum for visible pores and oil balance.',
      'Serum',
      ['serum', 'clarifying', 'niacinamide'],
      {
        concern: 'dullness',
        skin_type: 'oily, combination',
        key_ingredients: 'niacinamide, zinc',
        texture: 'gel',
        usage: 'morning or evening',
      },
      [
        { id: 2003, sku: 'DBC-NIASERUM-30', barcode: '8906123000038', title: '30 ml', price: 649 },
        { id: 2004, sku: 'DBC-NIASERUM-50', barcode: '8906123000045', title: '50 ml', price: 949 },
      ],
    ),
    product(
      1003,
      'Hyaluronic Hydra Serum',
      'Multi-weight hyaluronic acid serum for deep hydration.',
      'Serum',
      ['serum', 'hydrating'],
      {
        concern: 'dehydration',
        skin_type: 'dry, normal',
        key_ingredients: 'hyaluronic acid, panthenol',
        texture: 'serum',
        usage: 'morning and evening',
      },
      [
        { id: 2005, sku: 'DBC-HASERUM-30', barcode: '8906123000052', title: '30 ml', price: 699 },
        { id: 2006, sku: 'DBC-HASERUM-50', barcode: '8906123000069', title: '50 ml', price: 999 },
      ],
    ),
    product(
      1004,
      'Ceramide Barrier Cream',
      'Rich ceramide moisturiser that repairs a weakened skin barrier.',
      'Moisturiser',
      ['moisturiser', 'hero', 'barrier-repair'],
      {
        concern: 'dryness',
        skin_type: 'dry, sensitive',
        key_ingredients: 'ceramides, squalane',
        texture: 'cream',
        usage: 'morning and evening',
      },
      [
        { id: 2007, sku: 'DBC-CERCREAM-50', barcode: '8906123000076', title: '50 g', price: 599 },
        { id: 2008, sku: 'DBC-CERCREAM-100', barcode: '8906123000083', title: '100 g', price: 999 },
      ],
    ),
    product(
      1005,
      'Oil-Free Gel Moisturiser',
      'Weightless gel moisturiser for oily and acne-prone skin.',
      'Moisturiser',
      ['moisturiser', 'oil-free'],
      {
        concern: 'dryness',
        skin_type: 'oily, acne-prone',
        key_ingredients: 'aloe, hyaluronic acid',
        texture: 'gel',
        usage: 'morning and evening',
      },
      [
        { id: 2009, sku: 'DBC-GELMOIST-50', barcode: '8906123000090', title: '50 g', price: 499 },
        { id: 2010, sku: 'DBC-GELMOIST-100', barcode: '8906123000106', title: '100 g', price: 849 },
      ],
    ),
    product(
      1006,
      'Mineral Sunscreen SPF 50',
      'Zinc oxide sunscreen, SPF 50 PA++++, no white cast.',
      'Sunscreen',
      ['sunscreen', 'hero', 'mineral'],
      {
        concern: 'sun protection',
        skin_type: 'sensitive, all',
        key_ingredients: 'zinc oxide',
        spf: '50',
        usage: 'morning',
      },
      [
        { id: 2011, sku: 'DBC-MINSPF-50', barcode: '8906123000113', title: '50 g', price: 649 },
        { id: 2012, sku: 'DBC-MINSPF-80', barcode: '8906123000120', title: '80 g', price: 899 },
      ],
    ),
    product(
      1007,
      'Ultra-Light Gel Sunscreen SPF 50',
      'Invisible gel sunscreen with a matte finish.',
      'Sunscreen',
      ['sunscreen', 'gel', 'matte'],
      {
        concern: 'sun protection',
        skin_type: 'oily, combination',
        key_ingredients: 'new-gen UV filters, niacinamide',
        spf: '50',
        usage: 'morning',
      },
      [{ id: 2013, sku: 'DBC-GELSPF-50', barcode: '8906123000137', title: '50 g', price: 599 }],
    ),
    product(
      1008,
      'Gentle Foaming Cleanser',
      'pH-balanced foaming face wash for daily use.',
      'Cleanser',
      ['cleanser', 'hero', 'gentle'],
      {
        concern: 'cleansing',
        skin_type: 'all',
        key_ingredients: 'amino acids, glycerin',
        texture: 'foam',
        usage: 'morning and evening',
      },
      [
        { id: 2014, sku: 'DBC-FOAMCLN-100', barcode: '8906123000144', title: '100 ml', price: 349 },
        { id: 2015, sku: 'DBC-FOAMCLN-200', barcode: '8906123000151', title: '200 ml', price: 599 },
      ],
    ),
    product(
      1009,
      'Salicylic Clear Cleanser',
      '2% salicylic acid cleanser for breakouts.',
      'Cleanser',
      ['cleanser', 'acne', 'salicylic-acid'],
      {
        concern: 'cleansing',
        skin_type: 'oily, acne-prone',
        key_ingredients: 'salicylic acid, tea tree',
        texture: 'gel',
        usage: 'evening',
      },
      [{ id: 2016, sku: 'DBC-SALCLN-100', barcode: '8906123000168', title: '100 ml', price: 399 }],
    ),
    product(
      1010,
      'Overnight Repair Night Cream',
      'Retinal-free night cream with peptides for overnight renewal.',
      'Night care',
      ['night-cream', 'repair', 'peptides'],
      {
        concern: 'fine lines',
        skin_type: 'normal, dry',
        key_ingredients: 'peptides, bakuchiol',
        texture: 'cream',
        usage: 'evening',
      },
      [
        { id: 2017, sku: 'DBC-NIGHTCRM-30', barcode: '8906123000175', title: '30 g', price: 749 },
        { id: 2018, sku: 'DBC-NIGHTCRM-50', barcode: '8906123000182', title: '50 g', price: 1099 },
      ],
    ),
  ],
  customers: [
    {
      externalCustomerId: gid('Customer', 3001),
      firstName: 'Test',
      email: null,
      phone: null,
      marketingConsent: 'NOT_OPTED_IN',
    },
    // Synthetic demo shoppers for the local demo storefront's "Sign in as demo shopper" (M4):
    // one has marketing consent (follow-ups possible), one does not (NO_CONSENT path).
    {
      externalCustomerId: gid('Customer', 3002),
      firstName: 'Asha',
      email: null,
      phone: null,
      marketingConsent: 'OPTED_IN',
    },
    {
      externalCustomerId: gid('Customer', 3003),
      firstName: 'Ravi',
      email: null,
      phone: null,
      marketingConsent: 'NOT_OPTED_IN',
    },
  ],
  orders: [
    {
      externalOrderId: gid('Order', 4001),
      externalCustomerId: gid('Customer', 3001),
      lines: [{ externalVariantId: gid('ProductVariant', 2001), sku: 'DBC-VCSERUM-30', quantity: 1, unitPrice: 795 }],
      totalPrice: 795,
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
