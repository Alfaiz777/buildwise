import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/errors.js';
import type { CommerceProvider } from '../ports/commerce.js';
import type { CustomerRepository, IntentRepository, VisitorLinkRepository } from '../ports/conversationRepositories.js';
import type { ProductRepository } from '../ports/repositories.js';
import type { FollowUpService } from './followUpService.js';
import { intentIdFor, visitorHashOf } from './intentService.js';
import { variantIdFor } from './commerceSyncService.js';
import type { OrderService } from './orderService.js';

/** The synthetic shoppers the local demo storefront offers (mock commerce fixture). */
export const DEMO_SHOPPER_IDS = ['gid://shopify/Customer/3002', 'gid://shopify/Customer/3003'];

/** `gid://shopify/Customer/3002` → simulator ref `shopper_3002` (synthetic; never a real identifier). */
export const shopperRef = (externalCustomerId: string) =>
  `shopper_${externalCustomerId
    .split('/')
    .pop()!
    .replace(/[^A-Za-z0-9_-]/g, '')}`;

/**
 * LOCAL PROFILE ONLY: backs the demo storefront (docs/00 §11.8 Change 11). The composition
 * root wires it only in the local profile, so none of these endpoints exist in gcp.
 * - products: the synced catalogue, as a storefront needs it;
 * - signInShopper: mirrors a Shopify customer account with marketing consent — the link
 *   is made server-side from the commerce customer record, never from browser-sent PII;
 * - placeOrder: goes through the same OrderService path as the L2 orders webhook.
 */
export class DemoStorefrontService {
  constructor(
    private readonly deps: {
      commerce: CommerceProvider;
      products: ProductRepository;
      customers: CustomerRepository;
      visitors: VisitorLinkRepository;
      intents: IntentRepository;
      followUps: FollowUpService;
      orders: OrderService;
      now?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  async products(brandId: string) {
    const [products, variants] = await Promise.all([
      this.deps.products.listProducts(brandId),
      this.deps.products.listVariants(brandId),
    ]);
    return products
      .filter((p) => p.status === 'ACTIVE')
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((p) => ({
        product_id: p.productId,
        title: p.title,
        description: p.description,
        category: p.category,
        tags: p.tags,
        variants: variants
          .filter((v) => v.productId === p.productId && v.status === 'ACTIVE')
          .map((v) => ({
            shopify_variant_id: v.shopifyVariantId,
            title: v.title,
            price: v.price,
            currency: v.currency,
          })),
      }));
  }

  async shoppers() {
    const found = await Promise.all(DEMO_SHOPPER_IDS.map((id) => this.deps.commerce.getCustomer(id)));
    return found
      .filter((c) => c !== null)
      .map((c) => ({
        shopper_id: c.externalCustomerId,
        first_name: c.firstName,
        marketing_consent: c.marketingConsent,
        simulator_customer_ref: shopperRef(c.externalCustomerId),
      }));
  }

  async signInShopper(brandId: string, input: { shopperId: string; visitorId: string; webSessionId: string }) {
    const shopper = DEMO_SHOPPER_IDS.includes(input.shopperId)
      ? await this.deps.commerce.getCustomer(input.shopperId)
      : null;
    if (!shopper) throw new AppError(404, 'UNKNOWN_SHOPPER', 'This demo shopper does not exist.');
    const at = this.now().toISOString();
    const ref = shopperRef(shopper.externalCustomerId);
    const { customer } = await this.deps.customers.findOrCreateByIdentity(
      brandId,
      { channel: 'SIMULATOR', externalRef: `sim:${ref}` },
      {
        consentState: shopper.marketingConsent,
        shopifyCustomerId: shopper.externalCustomerId,
        displayRef: `sim:${ref}`,
      },
      at,
    );
    // The commerce record is the consent source of truth, but an opt-out always wins.
    if (customer.consentState !== 'OPTED_OUT' && customer.consentState !== shopper.marketingConsent) {
      await this.deps.customers.update(brandId, customer.customerId, { consentState: shopper.marketingConsent });
    }
    await this.deps.visitors.link(brandId, visitorHashOf(input.visitorId), {
      customerId: customer.customerId,
      linkSource: 'SIGNED_IN_SHOPPER',
      linkedAt: at,
    });
    // The current session becomes known too.
    await this.deps.intents.update(brandId, intentIdFor(brandId, input.webSessionId), (current) =>
      current && !current.customerId ? { ...current, customerId: customer.customerId, updatedAt: at } : null,
    );
    await this.deps.followUps.evaluateForCustomer(brandId, customer.customerId);
    return {
      shopper_id: shopper.externalCustomerId,
      first_name: shopper.firstName,
      marketing_consent: shopper.marketingConsent,
      simulator_customer_ref: ref,
    };
  }

  placeOrder(
    brandId: string,
    input: { webSessionId: string; shopifyVariantId: string | null; attributionRef?: string | null },
  ) {
    return this.deps.orders.recordOrder({
      brandId,
      webSessionId: input.webSessionId,
      externalOrderId: `demo_order_${randomUUID()}`,
      // The same normalisation as catalogue sync: Shopify variant GID → Buildwise variant ID.
      variantId: input.shopifyVariantId ? variantIdFor(input.shopifyVariantId) : null,
      source: 'WEBSITE',
      attributionRef: input.attributionRef ?? null,
    });
  }
}
