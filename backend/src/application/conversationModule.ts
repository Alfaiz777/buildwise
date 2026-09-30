import type { AgentRuntimeName } from '../domain/ai.js';
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
import type { AuditRepository, BrandRepository, ProductRepository } from '../ports/repositories.js';
import { buildConversationPipeline } from './conversation/stages.js';
import { ConversationQueryService } from './conversationQueryService.js';
import { DemoStorefrontService } from './demoStorefrontService.js';
import { EventRecorder } from './eventRecorder.js';
import { FollowUpService } from './followUpService.js';
import { IntentService } from './intentService.js';
import { OrderService } from './orderService.js';
import { SimulatorService } from './simulatorService.js';

export interface ConversationModuleDeps {
  brands: BrandRepository;
  products: ProductRepository;
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
  runtimeName: AgentRuntimeName;
  now?: () => Date;
  logger?: Logger;
  /** LOCAL PROFILE ONLY: enables the demo storefront service (never wired in gcp). */
  demoStorefront?: { commerce: CommerceProvider };
}

/**
 * Wires the M4 application services over ports only (the composition root and the test
 * world both call this, so they cannot drift apart).
 */
export function createConversationModule(deps: ConversationModuleDeps) {
  const now = deps.now ?? (() => new Date());
  const recorder = new EventRecorder({ events: deps.events, sink: deps.sink, audit: deps.audit, logger: deps.logger });
  const followUps = new FollowUpService({ ...deps, events: recorder, now });
  const orders = new OrderService({ events: recorder, followUps, now });
  const pipeline = buildConversationPipeline({
    ...deps,
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
  return {
    recorder,
    pipeline,
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
          now,
        })
      : undefined,
    simulator: new SimulatorService({
      messaging: deps.messaging,
      receipts: deps.receipts,
      runtimeName: deps.runtimeName,
      now,
      pipeline,
    }),
    queries: new ConversationQueryService({
      brands: deps.brands,
      products: deps.products,
      customers: deps.customers,
      intents: deps.intents,
      conversations: deps.conversations,
      recommendations: deps.recommendations,
      events: deps.events,
    }),
  };
}
