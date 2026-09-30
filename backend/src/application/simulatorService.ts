import type { BrandPrincipal } from '../domain/principal.js';
import { AppError } from '../lib/errors.js';
import type { MessageRecord } from '../ports/conversationRepositories.js';
import type { MessagingProvider } from '../ports/messaging.js';
import type { ConversationPipeline } from './conversation/pipeline.js';
import type { ConversationDeps } from './conversation/stages.js';
import { receiptKeyFor } from './conversation/stages.js';

export interface SimulatorResult {
  conversation_id: string;
  inbound_message_id: string;
  outbound_messages: ReturnType<typeof messageJson>[];
  decision: {
    recommendation_id: string | null;
    action: string;
    guardrail_status: string | null;
    runtime: string;
    decision_source: string | null;
    executed_action: null;
    policy_reason: string | null;
  };
}

export const messageJson = (m: MessageRecord) => ({
  message_id: m.messageId,
  direction: m.direction,
  message_type: m.messageType,
  text: m.text,
  options: m.options?.map((o) => ({ option_id: o.optionId, label: o.label })) ?? null,
  location: m.location,
  origin: m.origin,
  message_kind: m.messageKind,
  template_name: m.templateName,
  delivery_status: m.deliveryStatus,
  timestamp: m.timestamp,
});

/**
 * The simulator channel (docs/06_INTEGRATION_CONTRACTS.md §14.2): the simulator's
 * equivalent of the WhatsApp webhook. It normalizes the request with the simulator
 * adapter and hands it to the SAME ConversationPipeline. A replayed client_message_id
 * returns the original result without re-running any stage.
 */
export class SimulatorService {
  constructor(
    private readonly deps: Pick<ConversationDeps, 'messaging' | 'receipts' | 'runtimeName' | 'now'> & {
      pipeline: ConversationPipeline;
    },
  ) {}

  private provider(): MessagingProvider {
    const provider = this.deps.messaging.get('SIMULATOR');
    if (!provider) throw new AppError(404, 'CHANNEL_DISABLED', 'The simulator channel is not enabled.');
    return provider;
  }

  get enabled(): boolean {
    return this.deps.messaging.has('SIMULATOR');
  }

  async handle(principal: BrandPrincipal, body: unknown): Promise<SimulatorResult> {
    const provider = this.provider();
    let inbound;
    try {
      [inbound] = provider.normalizeInbound({
        brandId: principal.brandId,
        receivedAt: this.deps.now().toISOString(),
        body,
      });
    } catch {
      throw new AppError(400, 'INVALID_REQUEST', 'The simulator message is not valid.');
    }

    let run;
    try {
      run = await this.deps.pipeline.handleInbound(inbound!);
    } catch (err) {
      await this.deps.receipts.fail(`${inbound!.channel}:${inbound!.brandId}:MESSAGE:${inbound!.externalMessageId}`);
      throw err;
    }

    const { context } = run;
    if (run.stoppedAt?.stage === 'IDEMPOTENCY') {
      const duplicate = context.data.duplicate;
      if (duplicate?.status === 'PROCESSED' && duplicate.result) return duplicate.result as SimulatorResult;
      throw new AppError(409, 'MESSAGE_IN_PROGRESS', 'This message is still being processed.', true);
    }

    const decision = context.decision;
    const policy = context.data.policy;
    const result: SimulatorResult = {
      conversation_id: context.conversationId!,
      inbound_message_id: context.data.inboundMessageId!,
      outbound_messages: (context.data.sent ?? []).map(messageJson),
      decision: {
        recommendation_id: context.data.recommendationId ?? null,
        action: decision?.next_best_action.action ?? 'NO_ACTION',
        guardrail_status: context.guardrailStatus,
        runtime: decision?.runtime ?? this.deps.runtimeName,
        decision_source: context.decisionSource,
        executed_action: null,
        policy_reason: policy && policy.reply !== 'AUTOMATED' ? policy.reason : null,
      },
    };
    await this.deps.receipts.complete(receiptKeyFor(context), result);
    return result;
  }
}
