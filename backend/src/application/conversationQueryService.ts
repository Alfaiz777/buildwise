import { resolveMessagingSettings } from '../domain/brandSettings.js';
import { Errors } from '../lib/errors.js';
import type {
  JsonValue,
  CommerceEventRepository,
  ConversationRecord,
  ConversationRepository,
  CustomerRecord,
  CustomerRepository,
  IntentRecord,
  IntentRepository,
  MessageRecord,
  RecommendationRecord,
  RecommendationRepository,
} from '../ports/conversationRepositories.js';
import type { BrandRepository, ProductRepository, StoreRepository } from '../ports/repositories.js';
import type { ReservationRepository } from '../ports/reservations.js';

export interface IntentView {
  intent: IntentRecord;
  /** Safe label: the customer's display ref, or an opaque session reference for anonymous visitors. */
  who: string;
  anonymous: boolean;
  productTitle: string | null;
  variantTitle: string | null;
}

export interface ConversationSummary {
  conversation: ConversationRecord;
  customerRef: string;
  intent: IntentView | null;
}

export interface ConversationDetail extends ConversationSummary {
  brandDisplayName: string;
  messages: MessageRecord[];
  webEvents: { eventType: string; at: string; payload: Record<string, string | number | null> }[];
  recommendations: (RecommendationRecord & { reservation: ReservationSummary | null })[];
}

/** The reservation a decision created, for the "Why Qwikspot did this" trace. */
export interface ReservationSummary {
  reservationId: string;
  status: string;
  storeId: string;
  storeName: string;
  pickupCode: string;
  expiresAt: string;
}

/** Opaque, non-reversible reference for an anonymous session (never the raw session ID). */
export const sessionRef = (intent: IntentRecord) => `visitor ${intent.intentId.slice(-6)}`;

/**
 * Brand Console read model for "Conversations & intents" (docs/11 §4). Brand-scoped:
 * every method takes the principal's brand; another brand's records are 404.
 */
export class ConversationQueryService {
  constructor(
    private readonly deps: {
      brands: BrandRepository;
      products: ProductRepository;
      customers: CustomerRepository;
      intents: IntentRepository;
      conversations: ConversationRepository;
      recommendations: RecommendationRepository;
      events: CommerceEventRepository;
      /** M5: reservations referenced by a decision trace. */
      reservations?: ReservationRepository;
      stores?: StoreRepository;
    },
  ) {}

  private async titles(brandId: string) {
    const [products, variants] = await Promise.all([
      this.deps.products.listProducts(brandId),
      this.deps.products.listVariants(brandId),
    ]);
    return {
      product: new Map(products.map((p) => [p.productId, p.title])),
      variant: new Map(variants.map((v) => [v.variantId, v.title])),
    };
  }

  private view(
    intent: IntentRecord,
    customers: Map<string, CustomerRecord | null>,
    titles: Awaited<ReturnType<ConversationQueryService['titles']>>,
  ): IntentView {
    const customer = intent.customerId ? customers.get(intent.customerId) : null;
    return {
      intent,
      who: customer?.displayRef ?? sessionRef(intent),
      anonymous: !customer,
      productTitle: intent.productId ? (titles.product.get(intent.productId) ?? null) : null,
      variantTitle: intent.variantId ? (titles.variant.get(intent.variantId) ?? null) : null,
    };
  }

  private async customerMap(brandId: string, ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const found = await Promise.all(unique.map((id) => this.deps.customers.get(brandId, id)));
    return new Map(unique.map((id, i) => [id, found[i] ?? null]));
  }

  async listConversations(brandId: string): Promise<ConversationSummary[]> {
    const conversations = await this.deps.conversations.list(brandId, 100);
    const customers = await this.customerMap(
      brandId,
      conversations.map((c) => c.customerId),
    );
    const titles = await this.titles(brandId);
    const intents = await Promise.all(
      conversations.map((c) => (c.currentIntentId ? this.deps.intents.get(brandId, c.currentIntentId) : null)),
    );
    return conversations.map((conversation, i) => ({
      conversation,
      customerRef: customers.get(conversation.customerId)?.displayRef ?? 'customer',
      intent: intents[i] ? this.view(intents[i]!, customers, titles) : null,
    }));
  }

  async conversationDetail(brandId: string, conversationId: string): Promise<ConversationDetail> {
    const conversation = await this.deps.conversations.get(brandId, conversationId);
    if (!conversation) throw Errors.notFound();
    const brand = await this.deps.brands.getById(brandId);
    const customers = await this.customerMap(brandId, [conversation.customerId]);
    const titles = await this.titles(brandId);
    const intent = conversation.currentIntentId
      ? await this.deps.intents.get(brandId, conversation.currentIntentId)
      : null;
    const [messages, recommendations, events] = await Promise.all([
      this.deps.conversations.listMessages(brandId, conversationId),
      this.deps.recommendations.listByConversation(brandId, conversationId),
      intent ? this.deps.events.listByWebSession(brandId, intent.webSessionId) : Promise.resolve([]),
    ]);
    return {
      conversation,
      customerRef: customers.get(conversation.customerId)?.displayRef ?? 'customer',
      intent: intent ? this.view(intent, customers, titles) : null,
      brandDisplayName: brand ? resolveMessagingSettings(brand.settings, brand.name).displayName : '',
      messages,
      webEvents: events
        .filter(
          (e) => e.source === 'WEBSITE' || e.eventType === 'ORDER_CREATED' || e.eventType.startsWith('FOLLOW_UP_'),
        )
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .map((e) => ({ eventType: e.eventType, at: e.timestamp, payload: displayPayload(e.payload) })),
      recommendations: await this.withReservations(brandId, recommendations),
    };
  }

  private async withReservations(brandId: string, recommendations: RecommendationRecord[]) {
    const stores = this.deps.stores ? await this.deps.stores.list(brandId) : [];
    return Promise.all(
      recommendations.map(async (r) => {
        const id = r.trace?.executed_action?.reservation_id;
        const reservation = id && this.deps.reservations ? await this.deps.reservations.get(brandId, id) : null;
        return {
          ...r,
          reservation: reservation
            ? {
                reservationId: reservation.reservationId,
                status: reservation.status,
                storeId: reservation.storeId,
                storeName: stores.find((s) => s.storeId === reservation.storeId)?.storeName ?? reservation.storeId,
                pickupCode: reservation.pickupCode,
                expiresAt: reservation.expiresAt,
              }
            : null,
        };
      }),
    );
  }

  async listIntents(brandId: string, filter: { type?: string; followUpStatus?: string }): Promise<IntentView[]> {
    const intents = (await this.deps.intents.list(brandId, 200)).filter(
      (i) =>
        (!filter.type || i.type === filter.type) &&
        (!filter.followUpStatus || (i.followUp?.status ?? 'NONE') === filter.followUpStatus),
    );
    const customers = await this.customerMap(
      brandId,
      intents.map((i) => i.customerId),
    );
    const titles = await this.titles(brandId);
    return intents.map((i) => this.view(i, customers, titles));
  }

  /** Simulator polling: messages of a SIMULATOR conversation of this brand. */
  async simulatorMessages(brandId: string, conversationId: string, after?: string): Promise<MessageRecord[]> {
    const conversation = await this.deps.conversations.get(brandId, conversationId);
    if (!conversation || conversation.channel !== 'SIMULATOR') throw Errors.notFound();
    return this.deps.conversations.listMessages(brandId, conversationId, after);
  }
}

/** The event trail shown in the console: never internal IDs beyond the product. */
function displayPayload(payload: { [key: string]: JsonValue }): Record<string, string | number | null> {
  const allowed = ['matched_category', 'search_term', 'entry', 'reason', 'template_name', 'message_kind'];
  return Object.fromEntries(
    Object.entries(payload).filter(
      (entry): entry is [string, string | number | null] =>
        allowed.includes(entry[0]) && (entry[1] === null || ['string', 'number'].includes(typeof entry[1])),
    ),
  );
}
