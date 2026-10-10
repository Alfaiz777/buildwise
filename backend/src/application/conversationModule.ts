import type { Channel } from '../domain/channels.js';
import type { Logger } from '../lib/logger.js';
import type {
  CommerceEventRepository,
  ConversationRepository,
  CustomerRepository,
  IntentRepository,
  IntentTokenRepository,
  RecommendationRepository,
  VisitorLinkRepository,
  WebhookReceiptRepository,
} from '../ports/conversationRepositories.js';
import type { CommerceProvider } from '../ports/commerce.js';
import type { EventSink } from '../ports/events.js';
import type { MessagingProvider } from '../ports/messaging.js';
import type { AgentRuntime } from '../ports/agent.js';
import type { ReservationRepository } from '../ports/reservations.js';
import type {
  AuditRepository,
  BrandRepository,
  ConnectionRepository,
  InventoryRepository,
  ProductRepository,
  StoreRepository,
} from '../ports/repositories.js';
import { buildConversationPipeline } from './conversation/stages.js';
import { ConversationQueryService } from './conversationQueryService.js';
import { DemoStorefrontService } from './demoStorefrontService.js';
import { EventRecorder } from './eventRecorder.js';
import { FollowUpService } from './followUpService.js';
import { IntentService } from './intentService.js';
import { OrderService } from './orderService.js';
import type { OnlineStockService } from './onlineStock.js';
import { ReservationService } from './reservationService.js';
import { createToolHandlers } from './agent/tools.js';
import { AttributionService } from './attributionService.js';
import { FulfilmentService } from './fulfilmentService.js';
import { HandoffService } from './handoffService.js';
import { OutcomeService } from './outcomeService.js';
import type { AttributionRefRepository, OutcomeRepository } from '../ports/outcomes.js';
import { ShopperChannelService } from './shopperChannel.js';
import { SimulatorService } from './simulatorService.js';

export interface ConversationModuleDeps {
  brands: BrandRepository;
  products: ProductRepository;
  connections: ConnectionRepository;
  customers: CustomerRepository;
  visitors: VisitorLinkRepository;
  intents: IntentRepository;
  tokens: IntentTokenRepository;
  conversations: ConversationRepository;
  recommendations: RecommendationRepository;
  receipts: WebhookReceiptRepository;
  events: CommerceEventRepository;
  audit: AuditRepository;
  sink: EventSink;
  messaging: ReadonlyMap<Channel, MessagingProvider>;
  /** M5: stores and stock for the agent tools and the reservation transaction. */
  stores: StoreRepository;
  inventory: InventoryRepository;
  reservations: ReservationRepository;
  /** The configured AgentRuntime (its name is recorded on every decision). */
  agent: AgentRuntime;
  /** Test hook: the per-message AI budget (docs/03 §16.1). */
  aiBudgetMs?: number;
  /** Test hook: outbound retry backoff (docs/03 §16.2). */
  sendRetryDelaysMs?: readonly number[];
  /** Test hook: deterministic pickup codes. */
  pickupCode?: () => string;
  /** M6: outcomes and attribution references. */
  outcomes: OutcomeRepository;
  attributionRefs: AttributionRefRepository;
  now?: () => Date;
  logger?: Logger;
  /** The demo storefront service: local profile, or gcp with DEMO_MODE on (Change 16). */
  demoStorefront?: { commerce: CommerceProvider };
  /** The shopper demo channel (Change 16): local profile, or gcp with DEMO_MODE on. */
  shopperChannel?: { sessionSecret: string | null; brandAllowed: (brandId: string) => boolean };
  /** Public web origin for media URLs (product images) in messages. */
  publicOrigin?: string;
  /** L2-Shopify: live online stock for "Buy online" (Shopify mode only). */
  onlineStock?: Pick<OnlineStockService, 'canBuyOnline'>;
}

/**
 * Wires the M4 application services over ports only (the composition root and the test
 * world both call this, so they cannot drift apart).
 */
export function createConversationModule(deps: ConversationModuleDeps) {
  const now = deps.now ?? (() => new Date());
  const recorder = new EventRecorder({ events: deps.events, sink: deps.sink, audit: deps.audit, logger: deps.logger });
  const reservations = new ReservationService({
    reservations: deps.reservations,
    products: deps.products,
    stores: deps.stores,
    events: recorder,
    now,
    pickupCode: deps.pickupCode,
    recommendations: deps.recommendations,
  });
  const outcomes = new OutcomeService({
    outcomes: deps.outcomes,
    recommendations: deps.recommendations,
    intents: deps.intents,
    conversations: deps.conversations,
    reservations: deps.reservations,
    products: deps.products,
    brands: deps.brands,
    events: recorder,
    now,
  });
  const attribution = new AttributionService({
    refs: deps.attributionRefs,
    brands: deps.brands,
    connections: deps.connections,
    now,
  });
  const fulfilment = new FulfilmentService({
    ...deps,
    reservations,
    outcomes,
    attribution,
    events: recorder,
    now,
    tools: createToolHandlers({ ...deps, reservations, events: recorder, now }),
  });
  const followUps = new FollowUpService({
    ...deps,
    events: recorder,
    now,
    expireReservations: (brandId) => fulfilment.expireDue(brandId),
    closeJourneys: (brandId) => outcomes.closeExpiredJourneys(brandId),
  });
  const orders = new OrderService({ events: recorder, followUps, now, attribution, outcomes, intents: deps.intents });
  const pipeline = buildConversationPipeline({
    ...deps,
    reservations,
    attribution,
    outcomes,
    runtimeName: deps.agent.runtime,
    events: recorder,
    now,
    onReply: (context) => followUps.onReply(context),
  });
  const intents = new IntentService({
    brands: deps.brands,
    products: deps.products,
    intents: deps.intents,
    tokens: deps.tokens,
    visitors: deps.visitors,
    events: recorder,
    now,
    onIntentUpdated: async (intent) => void (await followUps.evaluate(intent.brandId, intent.intentId)),
  });
  const simulator = new SimulatorService({
    messaging: deps.messaging,
    receipts: deps.receipts,
    runtimeName: deps.agent.runtime,
    now,
    pipeline,
  });
  return {
    recorder,
    pipeline,
    reservations,
    fulfilment,
    handoff: new HandoffService({ ...deps, events: recorder, now }),
    outcomes,
    attribution,
    intents,
    followUps,
    orders,
    demoStorefront: deps.demoStorefront
      ? new DemoStorefrontService({
          commerce: deps.demoStorefront.commerce,
          products: deps.products,
          customers: deps.customers,
          visitors: deps.visitors,
          intents: deps.intents,
          followUps,
          orders,
          events: recorder,
          now,
        })
      : undefined,
    simulator,
    shopper: deps.shopperChannel
      ? new ShopperChannelService({
          sessionSecret: deps.shopperChannel.sessionSecret,
          brandAllowed: deps.shopperChannel.brandAllowed,
          brands: deps.brands,
          customers: deps.customers,
          conversations: deps.conversations,
          simulator,
          checkOrigin: (brandId, origin) => intents.brandForOrigin(brandId, origin),
          publicOrigin: deps.publicOrigin ?? 'http://localhost:5173',
          audit: deps.audit,
          now,
        })
      : undefined,
    queries: new ConversationQueryService({
      brands: deps.brands,
      products: deps.products,
      customers: deps.customers,
      intents: deps.intents,
      conversations: deps.conversations,
      recommendations: deps.recommendations,
      events: deps.events,
      reservations: deps.reservations,
      stores: deps.stores,
      outcomes: deps.outcomes,
    }),
  };
}
