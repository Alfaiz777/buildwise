import { resolveMessagingSettings } from '../domain/brandSettings.js';
import { journeyKeyFor } from '../domain/outcomeRules.js';
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
import type { OutcomeRecord, OutcomeRepository } from '../ports/outcomes.js';
import type { ReservationRecord, ReservationRepository } from '../ports/reservations.js';
import { OutcomeService } from './outcomeService.js';

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
  /** UI-3: the journey's recorded outcome(s), one per journey key of its decisions. */
  outcomes: (OutcomeRecord & { storeName: string | null })[];
}

/** The reservation a decision created, for the "Why Qwikspot did this" trace. */
export interface ReservationSummary {
  reservationId: string;
  status: string;
  storeId: string;
  storeName: string;
  pickupCode: string;
  expiresAt: string;
  /** UI-3: what was held and how the hold moved, from the record's own timestamps. */
  quantity: number;
  productTitle: string | null;
  variantTitle: string | null;
  statusHistory: StatusStep[];
}

export interface StatusStep {
  status: string;
  at: string;
  by?: string | null;
  reason?: string | null;
}

/**
 * The reservation's status changes in order, derived from the timestamps it stores (no
 * separate history is kept). The internal refusal note is never included.
 */
export function statusHistory(r: ReservationRecord): StatusStep[] {
  const steps: StatusStep[] = [{ status: 'PENDING', at: r.createdAt }];
  const add = (status: string, at: string | null) => at && steps.push({ status, at });
  add('CONFIRMED', r.confirmedAt);
  add('READY', r.readyAt);
  add('CUSTOMER_ARRIVED', r.customerArrivedAt);
  add('COMPLETED', r.completedAt);
  if (r.status === 'CANCELLED' && r.cancelledAt) {
    steps.push({ status: 'CANCELLED', at: r.cancelledAt, by: r.cancelledBy, reason: r.cancelReason });
  }
  if (r.status === 'EXPIRED') steps.push({ status: 'EXPIRED', at: r.expiresAt });
  return steps.sort((a, b) => a.at.localeCompare(b.at));
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
      /** UI-3: the journey's outcome on the conversation detail. */
      outcomes?: OutcomeRepository;
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
      recommendations: await this.withReservations(brandId, recommendations, titles),
      outcomes: await this.outcomesOf(brandId, recommendations),
    };
  }

  /** Outcome IDs are deterministic per journey (OutcomeService.idFor): no query needed. */
  private async outcomesOf(brandId: string, recommendations: RecommendationRecord[]) {
    if (!this.deps.outcomes) return [];
    const keys = [...new Set(recommendations.map(journeyKeyFor))];
    const found = await Promise.all(
      keys.map((key) => this.deps.outcomes!.get(brandId, OutcomeService.idFor(brandId, key))),
    );
    const stores = this.deps.stores ? await this.deps.stores.list(brandId) : [];
    return found
      .filter((o): o is OutcomeRecord => !!o)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((o) => ({ ...o, storeName: stores.find((s) => s.storeId === o.storeId)?.storeName ?? null }));
  }

  private async withReservations(
    brandId: string,
    recommendations: RecommendationRecord[],
    titles: Awaited<ReturnType<ConversationQueryService['titles']>>,
  ) {
    const stores = this.deps.stores ? await this.deps.stores.list(brandId) : [];
    const variants = await this.deps.products.listVariants(brandId);
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
                quantity: reservation.quantity,
                productTitle: (() => {
                  const productId = variants.find((v) => v.variantId === reservation.variantId)?.productId;
                  return productId ? (titles.product.get(productId) ?? null) : null;
                })(),
                variantTitle: titles.variant.get(reservation.variantId) ?? null,
                statusHistory: statusHistory(reservation),
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
