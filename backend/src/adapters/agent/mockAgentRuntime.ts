import type {
  CustomerHistoryOutput,
  NearbyStoresOutput,
  ProductContextOutput,
  ProductSheet,
} from '../../domain/agentTools.js';
import type { AiAction, IntentType } from '../../domain/ai.js';
import {
  clarifyReply,
  compareReply,
  discoveryReply,
  educateReply,
  handoffReply,
  noEligibleStoreReply,
  noPendingHoldReply,
  onlinePurchaseReply,
  refusalReply,
  whichProductReply,
  cancelNotFoundReply,
  type Reply,
} from '../../domain/agentReplies.js';
import { classifyMessage } from '../../domain/mockAgentRules.js';
import type { AgentDecision, AgentRuntime, DecisionInput, ToolExecutor, ToolResult } from '../../ports/agent.js';

/**
 * Deterministic stand-in for AdkGeminiAgentRuntime (docs/05_AI_AGENT_SPEC.md §9.2). For
 * pipeline tests and local development ONLY: every decision is runtime = MOCK and is never
 * presented as Gemini. It runs the same loop as the real runtime — read the context
 * package, call read tools through the backend ToolExecutor, decide — and proposes writes
 * through next_best_action; it never writes anything itself.
 *
 * Test hooks (constructor options, never reachable from a customer message): `delayMs`
 * simulates a slow model (the pipeline's budget → deterministic fallback) and
 * `invalidOutput` returns output that fails AgentDecisionSchema (once → repaired; always →
 * fallback).
 */
export interface MockAgentOptions {
  delayMs?: number;
  invalidOutput?: 'once' | 'always';
}

const URGENT = /\b(today|tonight|right now|asap|urgent(ly)?|need it)\b/i;

export class MockAgentRuntime implements AgentRuntime {
  readonly runtime = 'MOCK' as const;

  constructor(private readonly options: MockAgentOptions = {}) {}

  async decide(input: DecisionInput, tools: ToolExecutor): Promise<AgentDecision> {
    if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    const invalid = this.options.invalidOutput;
    if (invalid === 'always' || (invalid === 'once' && !input.repair)) {
      return { runtime: 'MOCK', next_best_action: { action: 'RESERVE_EVERYTHING' } } as unknown as AgentDecision;
    }
    return new MockRun(input, tools).decide();
  }
}

class MockRun {
  private readonly calls: ToolResult[] = [];
  private readonly ctx;
  private readonly text: string;

  constructor(
    private readonly input: DecisionInput,
    private readonly tools: ToolExecutor,
  ) {
    this.ctx = input.context;
    this.text = input.text ?? '';
  }

  private async call<T>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ result: ToolResult; output: T | null }> {
    const result = await this.tools.execute({ tool, input: args });
    this.calls.push(result);
    return { result, output: result.status === 'EXECUTED' ? (result.output as T) : null };
  }

  private decision(d: {
    action: AiAction;
    reply: Reply;
    reason: string;
    intentType?: IntentType;
    confidence?: number;
    storeId?: string;
    variantId?: string;
    quantity?: number;
    reservationId?: string;
    requiredTools?: string[];
    includeStoreContext?: boolean;
    askForConfirmation?: boolean;
  }): AgentDecision {
    const intentType = d.intentType ?? this.ctx.intent?.intent_type ?? 'UNKNOWN';
    return {
      runtime: 'MOCK',
      intent: { intent_type: intentType, confidence: d.confidence ?? 0.8 },
      intervention: { should_intervene: d.action !== 'NO_ACTION', reason: d.reason },
      next_best_action: {
        action: d.action,
        ...(d.storeId ? { store_id: d.storeId } : {}),
        ...(d.variantId ? { variant_id: d.variantId } : {}),
        ...(d.quantity ? { quantity: d.quantity } : {}),
        ...(d.reservationId ? { reservation_id: d.reservationId } : {}),
        reason: d.reason,
      },
      response_strategy: {
        tone: 'friendly',
        include_store_context: d.includeStoreContext ?? false,
        ask_for_confirmation: d.askForConfirmation ?? false,
      },
      required_tools: d.requiredTools ?? [],
      tool_calls: this.calls.map((c) => ({ tool: c.tool, status: c.status, result_reference: c.resultReference })),
      reply: d.reply,
    };
  }

  /** Adds record_customer_intent when the conversation refines the bound intent's type. */
  private refine(type: IntentType, tools: string[] = []): string[] {
    return this.ctx.intent && this.ctx.intent.intent_type !== type ? [...tools, 'record_customer_intent'] : tools;
  }

  private get canHold() {
    return this.ctx.brand.reservation_policy.reservations_enabled;
  }

  async decide(): Promise<AgentDecision> {
    const content = this.input.message.content;
    const rule = classifyMessage({
      text: this.text,
      optionId: content.type === 'INTERACTIVE_REPLY' ? content.optionId : null,
      isLocation: content.type === 'LOCATION',
      mentionsArea: false,
    });
    switch (rule.rule) {
      case 'REFUSE':
        return this.decision({
          action: 'NO_ACTION',
          reply: refusalReply(),
          reason: 'Request for other customers, private data or instructions: refused (no tools called).',
          confidence: 0.95,
        });
      case 'HUMAN':
        return this.ctx.brand.handoff_enabled
          ? this.decision({
              action: 'HUMAN_HANDOFF',
              reply: handoffReply(this.ctx.brand.display_name),
              reason: 'Explicit request for a person; human handoff is enabled.',
              intentType: 'SUPPORT_REQUEST',
              confidence: 0.95,
              requiredTools: ['request_human_handoff'],
            })
          : this.decision({
              action: 'NO_ACTION',
              reply: clarifyReply(this.boundProduct()?.title ?? null),
              reason: 'Asked for a person, but the brand has human handoff switched off.',
              intentType: 'SUPPORT_REQUEST',
            });
      case 'CANCEL':
        return this.cancel(rule.reservationId);
      case 'HOLD':
        return this.hold(rule.storeId);
      case 'BUY_ONLINE':
        return this.buyOnline();
      case 'OTHER_STORES':
        return this.storeSearch({ otherStores: true, fromLocation: false });
      case 'STORE_SEARCH':
        return this.storeSearch({ otherStores: false, fromLocation: rule.fromLocation, variantId: rule.variantId });
      case 'EDUCATE':
        return this.educate();
      case 'COMPARE':
        return this.compare();
      default:
        // A bare area name ("I'm in Powai") answers the location question: only a store locality counts.
        if (this.text && (this.ctx.pending_proposal || this.ctx.intent?.variant_id)) {
          return this.storeSearch({ otherStores: false, fromLocation: false, areaOnly: true });
        }
        return this.clarify();
    }
  }

  private clarify(): AgentDecision {
    return this.decision({
      action: 'NO_ACTION',
      reply: clarifyReply(this.boundProduct()?.title ?? null),
      reason: 'No rule matched: ask what the customer needs.',
      confidence: 0.4,
    });
  }

  private boundProduct(): ProductSheet | null {
    return this.ctx.products[0] ?? null;
  }

  private async cancel(reservationId: string | null): Promise<AgentDecision> {
    let id = reservationId;
    if (!id) {
      const { output } = await this.call<CustomerHistoryOutput>('get_customer_history', {});
      id = output?.active_reservations[0]?.reservation_id ?? null;
    }
    if (!id) {
      return this.decision({
        action: 'NO_ACTION',
        reply: cancelNotFoundReply(),
        reason: 'No active reservation to cancel.',
      });
    }
    return this.decision({
      action: 'NO_ACTION',
      reply: { message_type: 'TEXT', text: 'Cancelling your reservation.' },
      reason: 'Customer asked to cancel their own reservation.',
      reservationId: id,
      requiredTools: ['cancel_reservation'],
    });
  }

  private async hold(storeId: string | null): Promise<AgentDecision> {
    const pending = this.ctx.pending_proposal;
    if (!pending) {
      return this.decision({
        action: 'NO_ACTION',
        reply: noPendingHoldReply(),
        reason: 'Asked to reserve, but no store/variant is pending: ask first, create nothing.',
      });
    }
    const target = storeId ?? pending.store_id;
    await this.call('check_store_inventory', { store_id: target, variant_id: pending.variant_id });
    return this.decision({
      action: 'STORE_RESERVATION',
      reply: { message_type: 'TEXT', text: 'Placing your hold now.' },
      reason: 'Customer confirmed the offered hold.',
      intentType: 'URGENT_PURCHASE',
      confidence: 0.9,
      storeId: target,
      variantId: pending.variant_id,
      quantity: pending.quantity,
      requiredTools: ['create_reservation'],
      includeStoreContext: true,
    });
  }

  private async buyOnline(): Promise<AgentDecision> {
    const variantId = this.ctx.pending_proposal?.variant_id ?? this.ctx.intent?.variant_id ?? null;
    const productId = this.boundProduct()?.product_id;
    const { output } = await this.call<ProductContextOutput>(
      'get_product_context',
      variantId ? { variant_id: variantId } : productId ? { product_id: productId } : { query: this.text || 'product' },
    );
    if (!output?.product) {
      return this.decision({ action: 'NO_ACTION', reply: whichProductReply([]), reason: 'Product unknown.' });
    }
    return this.decision({
      action: 'ONLINE_PURCHASE',
      reply: onlinePurchaseReply({ title: output.product.title, url: output.product.online_url }),
      reason: 'Customer chose to buy online.',
      variantId: variantId ?? undefined,
    });
  }

  /** The variant being asked about: a size named in the text, the pending hold, the bound intent, or a catalogue match. */
  private async resolveVariant(): Promise<{ variantId: string | null; ask: Reply | null }> {
    const q = this.text.toLowerCase().replace(/(\d)\s+(ml|g)\b/g, '$1$2');
    for (const sheet of this.ctx.products.slice(0, 1)) {
      const named = sheet.variants.find((v) => q.includes(v.title.toLowerCase().replace(/(\d)\s+(ml|g)\b/g, '$1$2')));
      if (named) return { variantId: named.variant_id, ask: null };
    }
    const known = this.ctx.pending_proposal?.variant_id ?? this.ctx.intent?.variant_id ?? null;
    if (known) return { variantId: known, ask: null };
    const bound = this.boundProduct();
    if (bound?.variants.length === 1) return { variantId: bound.variants[0]!.variant_id, ask: null };
    if (!this.text) return { variantId: null, ask: whichProductReply([]) };
    const { output } = await this.call<ProductContextOutput>('get_product_context', { query: this.text });
    if (output?.status === 'FOUND' && output.product) {
      const variantId =
        output.variant_id ?? (output.product.variants.length === 1 ? output.product.variants[0]!.variant_id : null);
      return variantId
        ? { variantId, ask: null }
        : { variantId: null, ask: whichProductReply([{ title: output.product.title }]) };
    }
    return { variantId: null, ask: whichProductReply(output?.candidates ?? []) };
  }

  private async storeSearch(opts: {
    otherStores: boolean;
    fromLocation: boolean;
    areaOnly?: boolean;
    variantId?: string;
  }): Promise<AgentDecision> {
    const intentType: IntentType = URGENT.test(this.text)
      ? 'URGENT_PURCHASE'
      : (this.ctx.intent?.intent_type ?? 'STORE_ORIENTED');
    const { variantId, ask } = opts.variantId ? { variantId: opts.variantId, ask: null } : await this.resolveVariant();
    if (!variantId) {
      return this.decision({
        action: 'NO_ACTION',
        reply: ask!,
        reason: 'Product or size unclear: ask first.',
        intentType,
      });
    }
    const exclude = opts.otherStores && this.ctx.pending_proposal ? [this.ctx.pending_proposal.store_id] : [];
    const area = !opts.fromLocation && this.text ? { area: this.text } : {};
    const { output: find } = await this.call<NearbyStoresOutput>('find_nearby_stores', {
      variant_id: variantId,
      ...area,
      ...(exclude.length ? { skip_stores: exclude } : {}),
    });
    if (opts.areaOnly && find?.origin?.source !== 'LOCALITY' && find?.status !== 'AMBIGUOUS_AREA') {
      return this.clarify();
    }
    if (!find) {
      return this.decision({
        action: 'NO_ACTION',
        reply: clarifyReply(null),
        reason: 'Store search failed.',
        intentType,
      });
    }
    const reply = discoveryReply(find, { canHold: this.canHold });
    if (reply && find.status !== 'OK') {
      return this.decision({
        action: 'STORE_DISCOVERY',
        reply,
        reason:
          find.status === 'LOCATION_REQUIRED'
            ? 'No customer location: ask for the area, list no stores.'
            : 'Area is ambiguous: ask.',
        intentType,
        variantId,
      });
    }
    if (reply) {
      const best = find.eligible[0]!;
      return this.decision({
        action: 'STORE_DISCOVERY',
        reply,
        reason: `Nearest eligible store is ${best.store_name}; ${find.excluded.length} store(s) excluded by verified reasons.`,
        intentType,
        confidence: 0.85,
        storeId: best.store_id,
        variantId,
        requiredTools: this.refine(intentType),
        includeStoreContext: true,
        askForConfirmation: this.canHold,
      });
    }
    if (find.status !== 'OK' || !find.variant) {
      return this.decision({
        action: 'NO_ACTION',
        reply: whichProductReply([]),
        reason: 'Unknown variant.',
        intentType,
      });
    }
    // No eligible store: a verified alternative nearby, else online.
    const alternative = await this.findAlternative(find, area);
    const reply2 = noEligibleStoreReply({ variant: find.variant, alternative, canHold: this.canHold });
    return alternative
      ? this.decision({
          action: 'ALTERNATIVE_PRODUCT',
          reply: reply2,
          reason: `No eligible store for the requested variant; verified alternative at ${alternative.store.store_name}.`,
          intentType,
          storeId: alternative.store.store_id,
          variantId: alternative.variant.variant_id,
          requiredTools: this.refine(intentType),
          includeStoreContext: true,
        })
      : this.decision({
          action: 'ONLINE_PURCHASE',
          reply: reply2,
          reason: 'No eligible store nearby and no eligible alternative: offer online purchase.',
          intentType,
          variantId,
          requiredTools: this.refine(intentType),
        });
  }

  private async findAlternative(find: NearbyStoresOutput, area: { area?: string }) {
    const { output: product } = await this.call<ProductContextOutput>('get_product_context', {
      variant_id: find.variant!.variant_id,
    });
    const size = find.variant!.variant_title.toLowerCase();
    for (const alt of product?.alternatives ?? []) {
      const variant = alt.variants.find((v) => v.title.toLowerCase() === size);
      if (!variant) continue;
      const { output } = await this.call<NearbyStoresOutput>('find_nearby_stores', {
        variant_id: variant.variant_id,
        ...area,
      });
      if (output?.status === 'OK' && output.variant && output.eligible[0]) {
        return { variant: output.variant, store: output.eligible[0] };
      }
    }
    return null;
  }

  private async productForQuestion(): Promise<ProductContextOutput | null> {
    const bound = this.boundProduct();
    const { output } = await this.call<ProductContextOutput>(
      'get_product_context',
      bound ? { product_id: bound.product_id } : { query: this.text },
    );
    return output;
  }

  private async educate(): Promise<AgentDecision> {
    const ctx = await this.productForQuestion();
    if (!ctx?.product) {
      return this.decision({
        action: 'NO_ACTION',
        reply: whichProductReply(ctx?.candidates ?? []),
        reason: 'Product question without a known product: ask which one.',
        intentType: 'PRODUCT_QUESTION',
      });
    }
    const { reply, grounded } = educateReply(ctx.product, this.text);
    return this.decision({
      action: 'EDUCATE',
      reply,
      reason: grounded
        ? 'Answered from verified product attributes.'
        : 'Product data does not cover the question: said so.',
      intentType: 'PRODUCT_QUESTION',
      confidence: grounded ? 0.85 : 0.5,
      requiredTools: this.refine('PRODUCT_QUESTION'),
    });
  }

  private async compare(): Promise<AgentDecision> {
    const ctx = await this.productForQuestion();
    const other = ctx?.alternatives[0];
    if (!ctx?.product || !other) {
      return this.decision({
        action: 'NO_ACTION',
        reply: whichProductReply(ctx?.candidates ?? []),
        reason: 'Nothing verified to compare: ask which products.',
        intentType: 'COMPARISON',
      });
    }
    return this.decision({
      action: 'COMPARE',
      reply: compareReply(ctx.product, other),
      reason: `Compared ${ctx.product.title} with its verified alternative ${other.title}.`,
      intentType: 'COMPARISON',
      confidence: 0.8,
      requiredTools: this.refine('COMPARISON'),
    });
  }
}
