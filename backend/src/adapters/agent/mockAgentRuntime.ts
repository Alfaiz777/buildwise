import type {
  CatalogEntry,
  CustomerHistoryOutput,
  NearbyStoresOutput,
  ProductContextOutput,
  ProductSheet,
} from '../../domain/agentTools.js';
import type { AiAction, IntentType } from '../../domain/ai.js';
import {
  askLocationReply,
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
import { matchProducts, matchSize } from '../../domain/catalogMatch.js';
import { namedShownStore } from '../../domain/locality.js';
import { classifyMessage } from '../../domain/mockAgentRules.js';
import { detectLanguage, socialReply, type TurnType } from '../../domain/conversationalReplies.js';
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
const GREETING = /^\s*(hi+|hello+|hey+|namaste|good (morning|afternoon|evening))\b[\s!.,]*$/i;
/** How far back a follow-up question looks for the product being discussed. */
const HISTORY_LOOKBACK = 3;
/** find_nearby_stores accepts an area text of this length at most. */
const MAX_AREA_TEXT = 200;

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
    /** L5: the card of one store the customer named. */
    show?: 'ONE_STORE' | 'ALL_STORES';
    /** L5: the conversational turn a NO_ACTION answers. */
    turnType?: TurnType;
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
        ...(d.show ? { show: d.show } : {}),
        ...(d.turnType ? { turn_type: d.turnType } : {}),
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

  /**
   * A store search for a known product: refine the bound intent — or, when the conversation has
   * none (a customer who wrote in directly), record one so the product stays bound.
   */
  private refineOrBind(type: IntentType): string[] {
    return this.ctx.intent ? this.refine(type) : ['record_customer_intent'];
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
    // L5: a typed store name ("I'll go to GlowUp") among the stores just shown → that store's card.
    // Checked before every other rule, so "hold it at GlowUp" never holds at another store.
    const pending = this.ctx.pending_proposal;
    const named =
      content.type === 'TEXT' && pending?.offered_store_names?.length
        ? namedShownStore(this.text, pending.offered_store_names)
        : null;
    if (named && rule.rule !== 'REFUSE' && rule.rule !== 'HUMAN' && rule.rule !== 'CANCEL')
      return this.storeNamed(named);
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
              reply: this.clarifyText(),
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
        return this.storeSearch({
          otherStores: false,
          fromLocation: rule.fromLocation,
          variantId: rule.variantId,
          ...(rule.area ? { basis: rule.area } : {}),
        });
      case 'ASK_AREA':
        return this.decision({
          action: 'NO_ACTION',
          reply: askLocationReply(null, this.ctx.brand.areas ?? []),
          reason: 'The customer wants another area: ask which.',
        });
      case 'SOCIAL':
        return this.social(rule.turn);
      case 'EDUCATE':
        return this.educate();
      case 'COMPARE':
        return this.compare();
      default:
        // A bare area name ("I'm in Satellite") answers the location question: only a store locality counts.
        if (this.text && (this.ctx.pending_proposal || this.ctx.intent?.variant_id)) {
          return this.storeSearch({ otherStores: false, fromLocation: false, areaOnly: true });
        }
        return this.namedProductOnly();
    }
  }

  /** The customer's earlier messages in this conversation, newest first (a few at most). */
  private earlier(): string[] {
    const inbound = this.ctx.history.filter((m) => m.direction === 'INBOUND').map((m) => m.text);
    // The message being answered is already the newest entry of the history.
    if (this.text && inbound.at(-1)?.includes(this.text)) inbound.pop();
    return inbound.slice(-HISTORY_LOOKBACK).reverse();
  }

  /**
   * A message that only names a product ("Mineral Sunscreen SPF 50, 50 g") — usually the answer
   * to "which one do you mean?". If the customer was looking for a store, carry on with that
   * search (and the area they gave); otherwise offer what can be done for that product.
   */
  private namedProductOnly(): Promise<AgentDecision> | AgentDecision {
    const named = this.named(this.text);
    if (!named) return this.clarify();
    const search = this.earlier().find(
      (text) =>
        classifyMessage({ text, optionId: null, isLocation: false, mentionsArea: false }).rule === 'STORE_SEARCH',
    );
    if (search) return this.storeSearch({ otherStores: false, fromLocation: false, basis: `${this.text} ${search}` });
    return this.decision({
      action: 'NO_ACTION',
      reply: clarifyReply(named.entry.title),
      reason: 'The customer named a product: ask what they need for it.',
      confidence: 0.6,
    });
  }

  /**
   * L5: thanks, later, ok, bye, a compliment, a complaint, off-topic — a short natural answer in
   * the customer's language (no sales question after a closing; a person offered after a
   * complaint). A first hello still gets the welcome with example products.
   */
  private social(turn: TurnType): AgentDecision {
    const first = !this.ctx.history.some((m) => m.direction === 'OUTBOUND');
    if (turn === 'GREETING' && first) {
      return this.decision({
        action: 'NO_ACTION',
        reply: this.clarifyText(),
        reason: 'First hello: welcome and what the assistant can do.',
        confidence: 0.9,
        turnType: 'GREETING',
      });
    }
    return this.decision({
      action: 'NO_ACTION',
      reply: socialReply({
        turn,
        language: detectLanguage(this.text),
        productTitle: this.boundProduct()?.title ?? null,
        brandName: this.ctx.brand.display_name,
        handoffEnabled: this.ctx.brand.handoff_enabled,
      }),
      reason: `Conversational turn (${turn.toLowerCase().replace('_', ' ')}): a short reply, no action.`,
      confidence: 0.9,
      turnType: turn,
    });
  }

  private clarify(): AgentDecision {
    return this.decision({
      action: 'NO_ACTION',
      reply: this.clarifyText(),
      reason: 'No rule matched: ask what the customer needs.',
      confidence: 0.4,
    });
  }

  /** With a bound product: what to do with it. Without: a welcome (first message / greeting) and example names. */
  private clarifyText(): Reply {
    const first = !this.ctx.history.some((m) => m.direction === 'OUTBOUND');
    return clarifyReply(this.boundProduct()?.title ?? null, {
      brandName: this.ctx.brand.display_name,
      examples: this.examples,
      welcome: first || GREETING.test(this.text),
    });
  }

  /** A few product names from the catalogue index, as examples for "which product?". */
  private get examples(): string[] {
    return this.ctx.catalog.slice(0, 3).map((c) => c.title);
  }

  private askWhich(candidates: { title: string; sizes?: string[] }[] = []): Reply {
    return whichProductReply(candidates, this.examples);
  }

  /** The single product a text names (catalogue index), with the size when the text gives one. */
  private named(text: string): { entry: CatalogEntry; variantId: string | null } | null {
    if (!text) return null;
    const matches = matchProducts(text, this.ctx.catalog);
    if (matches.length !== 1) return null;
    const entry = matches[0]!;
    const variantId =
      matchSize(text, entry.variants)?.variant_id ??
      (entry.variants.length === 1 ? entry.variants[0]!.variant_id : null);
    return { entry, variantId };
  }

  /**
   * The product this conversation has been about, when nothing is bound or pending: the
   * customer's active reservation, else the most recent of their last few messages that
   * names a single product.
   */
  private async discussed(): Promise<{ productId: string | null; variantId: string | null } | null> {
    const { output } = await this.call<CustomerHistoryOutput>('get_customer_history', {});
    const reserved = output?.active_reservations[0]?.variant_id;
    if (reserved) return { productId: null, variantId: reserved };
    for (const text of this.earlier()) {
      const hit = this.named(text);
      if (hit) return { productId: hit.entry.product_id, variantId: hit.variantId };
    }
    return null;
  }

  /**
   * get_product_context arguments for a question without a clear product, in this order: the
   * product named now → the bound intent's product → the pending offer → the active
   * reservation → a product named in the last few messages → the text as a catalogue query.
   */
  private async productArgs(): Promise<Record<string, unknown>> {
    const named = this.named(this.text);
    if (named) return named.variantId ? { variant_id: named.variantId } : { product_id: named.entry.product_id };
    const bound = this.boundProduct();
    if (bound) return { product_id: bound.product_id };
    const known = this.ctx.pending_proposal?.variant_id ?? this.ctx.intent?.variant_id;
    if (known) return { variant_id: known };
    const discussed = await this.discussed();
    if (discussed?.variantId) return { variant_id: discussed.variantId };
    if (discussed?.productId) return { product_id: discussed.productId };
    return { query: this.text || 'product' };
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
    // A product named now wins; then the offer on the table, the bound variant, the conversation's product.
    const known = this.ctx.pending_proposal?.variant_id ?? this.ctx.intent?.variant_id ?? null;
    const args = this.named(this.text) || !known ? await this.productArgs() : { variant_id: known };
    const { output } = await this.call<ProductContextOutput>('get_product_context', args);
    const variantId = (args.variant_id as string | undefined) ?? output?.variant_id ?? null;
    if (!output?.product) {
      return this.decision({
        action: 'NO_ACTION',
        reply: this.askWhich(output?.candidates),
        reason: 'Product unknown.',
      });
    }
    return this.decision({
      action: 'ONLINE_PURCHASE',
      reply: onlinePurchaseReply({ title: output.product.title, url: output.product.online_url }),
      reason: 'Customer chose to buy online.',
      variantId: variantId ?? undefined,
    });
  }

  /**
   * The variant being asked about: a product (and size) named in the text, a size named for the
   * bound product, the pending hold, the bound intent, the product this conversation has been
   * about, or a catalogue match.
   */
  private async resolveVariant(): Promise<{ variantId: string | null; ask: Reply | null }> {
    const known = this.ctx.pending_proposal?.variant_id ?? this.ctx.intent?.variant_id ?? null;
    const named = this.named(this.text);
    if (named) {
      if (named.variantId) return { variantId: named.variantId, ask: null };
      // The product is named without a size: keep the size already in play for that product.
      if (known && named.entry.variants.some((v) => v.variant_id === known)) return { variantId: known, ask: null };
      const sizes = named.entry.variants.map((v) => v.title);
      return { variantId: null, ask: this.askWhich([{ title: named.entry.title, sizes }]) };
    }
    const sized = matchSize(this.text, this.ctx.products[0]?.variants ?? []);
    if (sized) return { variantId: sized.variant_id, ask: null };
    if (known) return { variantId: known, ask: null };
    const bound = this.boundProduct();
    if (bound?.variants.length === 1) return { variantId: bound.variants[0]!.variant_id, ask: null };
    if (!this.text) return { variantId: null, ask: this.askWhich() };
    const discussed = await this.discussed();
    if (discussed?.variantId) return { variantId: discussed.variantId, ask: null };
    const { output } = await this.call<ProductContextOutput>('get_product_context', { query: this.text });
    if (output?.status === 'FOUND' && output.product) {
      const variantId =
        output.variant_id ?? (output.product.variants.length === 1 ? output.product.variants[0]!.variant_id : null);
      return variantId
        ? { variantId, ask: null }
        : {
            variantId: null,
            ask: this.askWhich([{ title: output.product.title, sizes: output.product.variants.map((v) => v.title) }]),
          };
    }
    return { variantId: null, ask: this.askWhich(output?.candidates) };
  }

  private async storeSearch(opts: {
    otherStores: boolean;
    fromLocation: boolean;
    areaOnly?: boolean;
    variantId?: string;
    /** The text to read urgency and the area from, when it is more than the current message. */
    basis?: string;
  }): Promise<AgentDecision> {
    const basis = (opts.basis ?? this.text).slice(0, MAX_AREA_TEXT);
    const intentType: IntentType = URGENT.test(basis)
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
    // L5: in a brand with areas, "Other stores" lists the whole area, the store just shown included.
    const listsArea = (this.ctx.brand.areas?.length ?? 0) > 0;
    const exclude =
      opts.otherStores && this.ctx.pending_proposal && !listsArea ? [this.ctx.pending_proposal.store_id] : [];
    const area = !opts.fromLocation && basis ? { area: basis } : {};
    const { output: find } = await this.call<NearbyStoresOutput>('find_nearby_stores', {
      variant_id: variantId,
      ...area,
      ...(exclude.length ? { skip_stores: exclude } : {}),
    });
    if (
      opts.areaOnly &&
      find?.origin?.source !== 'LOCALITY' &&
      find?.status !== 'AMBIGUOUS_AREA' &&
      find?.status !== 'UNSERVED_AREA'
    ) {
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
    const showAll = opts.otherStores && listsArea;
    const reply = discoveryReply(find, { canHold: this.canHold, ...(showAll ? { listAll: true } : {}) });
    if (reply && find.status !== 'OK') {
      return this.decision({
        action: 'STORE_DISCOVERY',
        reply,
        reason:
          find.status === 'LOCATION_REQUIRED'
            ? 'No customer location: ask for the area, list no stores.'
            : find.status === 'UNSERVED_AREA'
              ? 'The named area has no store: name the areas that do.'
              : 'Area is ambiguous: ask.',
        intentType,
        variantId,
        // Keep the product for the customer's answer ("Navrangpura") when nothing is bound yet.
        requiredTools: this.ctx.intent ? [] : ['record_customer_intent'],
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
        requiredTools: this.refineOrBind(intentType),
        includeStoreContext: true,
        askForConfirmation: this.canHold,
        ...(showAll ? { show: 'ALL_STORES' as const } : {}),
      });
    }
    if (find.status !== 'OK' || !find.variant) {
      return this.decision({
        action: 'NO_ACTION',
        reply: this.askWhich(),
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
          requiredTools: this.refineOrBind(intentType),
        });
  }

  /**
   * L5: the customer typed the name of a store just shown. Its own card, with Pick up there — one
   * more tap holds it, so a typo or a vague "I'll go there" never reserves the wrong store.
   */
  private async storeNamed(storeId: string): Promise<AgentDecision> {
    const variantId = this.ctx.pending_proposal!.variant_id;
    const { output: find } = await this.call<NearbyStoresOutput>('find_nearby_stores', { variant_id: variantId });
    const store = find?.eligible.find((s) => s.store_id === storeId);
    if (!find || !store) {
      return this.storeSearch({ otherStores: false, fromLocation: true, variantId });
    }
    return this.decision({
      action: 'STORE_DISCOVERY',
      reply: discoveryReply(find, { canHold: this.canHold, onlyStoreId: storeId })!,
      reason: `The customer named ${store.store_name}: its card, a hold needs one more tap.`,
      intentType: this.ctx.intent?.intent_type ?? 'STORE_ORIENTED',
      confidence: 0.9,
      storeId,
      variantId,
      show: 'ONE_STORE',
      includeStoreContext: true,
      askForConfirmation: this.canHold,
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
    const { output } = await this.call<ProductContextOutput>('get_product_context', await this.productArgs());
    return output;
  }

  private async educate(): Promise<AgentDecision> {
    const ctx = await this.productForQuestion();
    if (!ctx?.product) {
      return this.decision({
        action: 'NO_ACTION',
        reply: this.askWhich(ctx?.candidates),
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
    // "Which is better, Hyaluronic Hydra Serum or Niacinamide Clarifying Serum?" — the two named.
    const named = matchProducts(this.text, this.ctx.catalog);
    if (named.length === 2) {
      const sheets = await Promise.all(
        named.map(async (entry) => {
          const { output } = await this.call<ProductContextOutput>('get_product_context', {
            product_id: entry.product_id,
          });
          return output?.product ?? null;
        }),
      );
      if (sheets[0] && sheets[1]) {
        return this.decision({
          action: 'COMPARE',
          reply: compareReply(sheets[0], sheets[1]),
          reason: `Compared the two products the customer named.`,
          intentType: 'COMPARISON',
          confidence: 0.8,
          requiredTools: this.refine('COMPARISON'),
        });
      }
    }
    const ctx = await this.productForQuestion();
    const other = ctx?.alternatives[0];
    if (!ctx?.product || !other) {
      return this.decision({
        action: 'NO_ACTION',
        reply: this.askWhich(ctx?.candidates),
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
