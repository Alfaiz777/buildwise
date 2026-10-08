import { parseDescription } from '../../domain/shopifyDescription.js';
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
import type { ShopifyAdminApi } from '../../ports/shopify.js';

type Status = CommerceProduct['status'];
const statusOf = (s: string | null | undefined): Status =>
  s === 'ARCHIVED' ? 'ARCHIVED' : s === 'DRAFT' ? 'DRAFT' : 'ACTIVE'; // ACTIVE and UNLISTED are sellable

const money = (amount: unknown) => {
  const n = typeof amount === 'string' ? Number(amount) : typeof amount === 'number' ? amount : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface ProductNode {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string | null;
  productType: string | null;
  status: string;
  tags: string[];
  featuredMedia: { preview?: { image?: { url?: string | null } | null } | null } | null;
  variants: Page<{ id: string; sku: string | null; barcode: string | null; title: string; price: string }>;
}

const PRODUCTS = /* GraphQL */ `
  query QwikspotProducts($after: String) {
    shop {
      currencyCode
    }
    products(first: 50, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        descriptionHtml
        productType
        status
        tags
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
        variants(first: 100) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            sku
            barcode
            title
            price
          }
        }
      }
    }
  }
`;

const VARIANT = /* GraphQL */ `
  query QwikspotVariant($id: ID!) {
    shop {
      currencyCode
    }
    productVariant(id: $id) {
      id
      sku
      barcode
      title
      price
      product {
        id
        status
      }
    }
  }
`;

const CUSTOMER = /* GraphQL */ `
  query QwikspotCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      defaultEmailAddress {
        emailAddress
        marketingState
      }
      defaultPhoneNumber {
        phoneNumber
        marketingState
      }
    }
  }
`;

const ORDER_FIELDS = /* GraphQL */ `
  id
  createdAt
  customer {
    id
  }
  totalPriceSet {
    shopMoney {
      amount
      currencyCode
    }
  }
  lineItems(first: 100) {
    nodes {
      sku
      quantity
      variant {
        id
        sku
      }
      originalUnitPriceSet {
        shopMoney {
          amount
        }
      }
    }
  }
`;
const ORDER = `query QwikspotOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;
const ORDERS = `query QwikspotOrders($after: String, $query: String) {
  orders(first: 50, after: $after, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS} }
  }
}`;

const LOCATIONS = `query QwikspotLocations($after: String) {
  locations(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { id name } }
}`;

const INVENTORY = `query QwikspotInventory($id: ID!) {
  productVariant(id: $id) {
    id
    inventoryItem {
      inventoryLevels(first: 50) {
        nodes { location { id } quantities(names: ["available"]) { name quantity } }
      }
    }
  }
}`;

interface OrderNode {
  id: string;
  createdAt: string;
  customer: { id: string } | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: {
    nodes: {
      sku: string | null;
      quantity: number;
      variant: { id: string; sku: string | null } | null;
      originalUnitPriceSet: { shopMoney: { amount: string } };
    }[];
  };
}

/**
 * CommerceProvider over the Shopify GraphQL Admin API (L2-Shopify; docs/06 §2, §8). One
 * instance per brand, built from that brand's stored connection. Shopify shapes stop here:
 * every method returns the normalized port shapes, ids stay Shopify GIDs.
 */
export class ShopifyCommerceProvider implements CommerceProvider {
  readonly name = 'SHOPIFY' as const;

  constructor(
    private readonly api: ShopifyAdminApi,
    private readonly shop: string,
    /** The current access token (refreshed by the caller when it is about to expire). */
    private readonly accessToken: () => Promise<string>,
  ) {}

  private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return this.api.graphql<T>(this.shop, await this.accessToken(), query, variables);
  }

  async getProducts(): Promise<CommerceProduct[]> {
    const out: CommerceProduct[] = [];
    let after: string | null = null;
    for (let page = 0; page < 200; page++) {
      const data: { shop: { currencyCode: string }; products: Page<ProductNode> } = await this.query(PRODUCTS, {
        after,
      });
      for (const p of data.products.nodes) out.push(this.product(p, data.shop.currencyCode));
      if (!data.products.pageInfo.hasNextPage) break;
      after = data.products.pageInfo.endCursor;
    }
    return out;
  }

  private product(p: ProductNode, currency: string): CommerceProduct {
    const { text, attributes } = parseDescription(p.descriptionHtml ?? '');
    const status = statusOf(p.status);
    return {
      externalProductId: p.id,
      title: p.title,
      description: text,
      category: p.productType?.trim() || null,
      status,
      tags: p.tags ?? [],
      attributes,
      imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
      handle: p.handle ?? null,
      variants: p.variants.nodes.map((v) => ({
        externalVariantId: v.id,
        externalProductId: p.id,
        sku: v.sku?.trim() ?? '',
        barcode: v.barcode?.trim() || null,
        title: v.title,
        price: money(v.price),
        currency,
        status,
      })),
    };
  }

  async getProductVariant(externalVariantId: string): Promise<CommerceVariant | null> {
    const data = await this.query<{
      shop: { currencyCode: string };
      productVariant: {
        id: string;
        sku: string | null;
        barcode: string | null;
        title: string;
        price: string;
        product: { id: string; status: string };
      } | null;
    }>(VARIANT, { id: externalVariantId });
    const v = data.productVariant;
    if (!v) return null;
    return {
      externalVariantId: v.id,
      externalProductId: v.product.id,
      sku: v.sku?.trim() ?? '',
      barcode: v.barcode?.trim() || null,
      title: v.title,
      price: money(v.price),
      currency: data.shop.currencyCode,
      status: statusOf(v.product.status),
    };
  }

  async getCustomer(externalCustomerId: string): Promise<CommerceCustomer | null> {
    const data = await this.query<{
      customer: {
        id: string;
        firstName: string | null;
        defaultEmailAddress: { emailAddress: string | null; marketingState: string | null } | null;
        defaultPhoneNumber: { phoneNumber: string | null; marketingState: string | null } | null;
      } | null;
    }>(CUSTOMER, { id: externalCustomerId });
    const c = data.customer;
    if (!c) return null;
    const subscribed = [c.defaultEmailAddress?.marketingState, c.defaultPhoneNumber?.marketingState].includes(
      'SUBSCRIBED',
    );
    return {
      externalCustomerId: c.id,
      firstName: c.firstName,
      email: c.defaultEmailAddress?.emailAddress ?? null,
      phone: c.defaultPhoneNumber?.phoneNumber ?? null,
      marketingConsent: subscribed ? 'OPTED_IN' : 'NOT_OPTED_IN',
    };
  }

  private order(o: OrderNode): CommerceOrder {
    return {
      externalOrderId: o.id,
      externalCustomerId: o.customer?.id ?? null,
      lines: o.lineItems.nodes
        .filter((l) => l.variant)
        .map((l) => ({
          externalVariantId: l.variant!.id,
          sku: l.variant!.sku ?? l.sku ?? '',
          quantity: l.quantity,
          unitPrice: money(l.originalUnitPriceSet.shopMoney.amount),
        })),
      totalPrice: money(o.totalPriceSet.shopMoney.amount),
      currency: o.totalPriceSet.shopMoney.currencyCode,
      createdAt: o.createdAt,
    };
  }

  async getOrder(externalOrderId: string): Promise<CommerceOrder | null> {
    const data = await this.query<{ order: OrderNode | null }>(ORDER, { id: externalOrderId });
    return data.order ? this.order(data.order) : null;
  }

  async getOrders(query: OrderQuery): Promise<CommerceOrder[]> {
    const terms: string[] = [];
    if (query.externalCustomerId) terms.push(`customer_id:${query.externalCustomerId.split('/').pop()}`);
    if (query.createdAfter) terms.push(`created_at:>${query.createdAfter}`);
    const out: CommerceOrder[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data: { orders: Page<OrderNode> } = await this.query(ORDERS, {
        after,
        query: terms.join(' ') || null,
      });
      out.push(...data.orders.nodes.map((o) => this.order(o)));
      if (!data.orders.pageInfo.hasNextPage) break;
      after = data.orders.pageInfo.endCursor;
    }
    return out;
  }

  async getLocations(): Promise<CommerceLocation[]> {
    const out: CommerceLocation[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data: { locations: Page<{ id: string; name: string }> } = await this.query(LOCATIONS, { after });
      out.push(...data.locations.nodes.map((l) => ({ externalLocationId: l.id, name: l.name })));
      if (!data.locations.pageInfo.hasNextPage) break;
      after = data.locations.pageInfo.endCursor;
    }
    return out;
  }

  /** Online stock per location for the given variants (retail store stock comes from the retail file). */
  async getInventory(query: InventoryQuery): Promise<CommerceInventoryLevel[]> {
    const out: CommerceInventoryLevel[] = [];
    for (const id of query.externalVariantIds ?? []) {
      const data = await this.query<{
        productVariant: {
          id: string;
          inventoryItem: {
            inventoryLevels: {
              nodes: { location: { id: string }; quantities: { name: string; quantity: number }[] }[];
            };
          } | null;
        } | null;
      }>(INVENTORY, { id });
      for (const level of data.productVariant?.inventoryItem?.inventoryLevels.nodes ?? []) {
        out.push({
          externalVariantId: id,
          externalLocationId: level.location.id,
          available: level.quantities.find((q) => q.name === 'available')?.quantity ?? 0,
        });
      }
    }
    return out;
  }
}
