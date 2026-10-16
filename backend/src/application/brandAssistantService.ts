/**
 * "Ask Qwikspot" (L5, docs/05 §18): the brand agent behind the Brand Console's AI pieces.
 *
 * - Builds a compact data pack from the same numbers the console shows (Insights panels, the
 *   store network with stock, holds right now, conversations). No shopper identity is in it.
 * - Answers through the shared AssistantRunner: Gemini (≤ 2 read-tool rounds) within 17 s,
 *   checked; otherwise the rules "Quick summary" — every answer within the 20 s ceiling.
 * - Read-only. Brand-scoped by the caller's BRAND principal.
 */
import {
  BRAND_ASSISTANT_PROMPT,
  BRAND_ASSISTANT_PROMPT_VERSION,
  BrandAnswerSchema,
  brandAnswerJsonSchema,
  PAGE_PATHS,
  quickAnswer,
  quickBrief,
  brandToolsFor,
  quickConversationSummary,
  redactPII,
  type BrandPack,
  type ConsolePage,
  type ConversationPack,
} from '../domain/brandAssistant.js';
import type { BrandPrincipal } from '../domain/principal.js';
import type { ConversationSummaryStore } from '../ports/brandAssistant.js';
import {
  ASSISTANT_CEILING_MS,
  BriefCache,
  DEFAULT_SCOPE,
  type AssistantAnswer as RunnerAnswer,
  type AssistantRunner,
  type AssistantScope,
  type AssistantTool,
} from './assistantRunner.js';
import type { ConversationQueryService } from './conversationQueryService.js';
import type { InsightsService } from './insightsService.js';
import type { ReservationService } from './reservationService.js';
import type { TenantAdminService } from './tenantAdminService.js';

export { DEFAULT_SCOPE };
export const BRAND_ASSISTANT_CEILING_MS = ASSISTANT_CEILING_MS;
/** What the team member is looking at: the period and whether synthetic demo history counts. */
export type PackScope = AssistantScope;
export type AssistantAnswer = RunnerAnswer<ConsolePage>;

export class BrandAssistantService {
  private readonly briefs = new BriefCache<AssistantAnswer>();

  constructor(
    private readonly deps: {
      runner: AssistantRunner;
      insights: InsightsService;
      tenantAdmin: Pick<TenantAdminService, 'listStores'>;
      reservations: Pick<ReservationService, 'listFor'>;
      conversations: Pick<ConversationQueryService, 'listConversations' | 'conversationDetail'>;
      summaries: ConversationSummaryStore;
      brands: { getById(brandId: string): Promise<{ name: string } | null> };
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** The common part of every brand answer (instruction, schema, page links). */
  private base(principal: BrandPrincipal) {
    return {
      console: 'brand' as const,
      brandId: principal.brandId,
      prompt: BRAND_ASSISTANT_PROMPT,
      promptVersion: BRAND_ASSISTANT_PROMPT_VERSION,
      schema: BrandAnswerSchema,
      answerSchema: brandAnswerJsonSchema(),
      pathOf: (page: ConsolePage) => PAGE_PATHS[page],
    };
  }

  /** Holds and conversations in scope: without synthetic history, only live records count. */
  private async records(principal: BrandPrincipal, scope: PackScope) {
    const [active, history, conversations] = await Promise.all([
      this.deps.reservations.listFor(principal, { view: 'active', limit: 500 }),
      this.deps.reservations.listFor(principal, { view: 'history', limit: 500 }),
      this.deps.conversations.listConversations(principal.brandId),
    ]);
    const live = <T extends { demo_history?: boolean }>(rows: T[]) =>
      scope.includeHistory ? rows : rows.filter((r) => !r.demo_history);
    return {
      active: live(active as unknown as ReservationRow[]),
      history: live(history as unknown as ReservationRow[]),
      conversations: scope.includeHistory ? conversations : conversations.filter((c) => !c.conversation.demoHistory),
    };
  }

  /**
   * The brand's data pack: what every AI piece and every quick summary is built from. Its totals
   * are the Overview tiles' own definitions, for the same period and synthetic-history choice.
   */
  async pack(principal: BrandPrincipal, scope: PackScope = DEFAULT_SCOPE): Promise<BrandPack> {
    const brandId = principal.brandId;
    const now = this.now();
    const [panels, stores, records, brand] = await Promise.all([
      this.deps.insights.panels(brandId, { days: scope.days, includeHistory: scope.includeHistory }),
      this.deps.tenantAdmin.listStores(principal),
      this.records(principal, scope),
      this.deps.brands.getById(brandId),
    ]);
    const { active, history, conversations } = records;
    const fill = new Map<string, { nearest: number; had: number; refusals: number }>();
    for (const row of panels.fill_rate) {
      const f = fill.get(row.store_id) ?? { nearest: 0, had: 0, refusals: 0 };
      f.nearest += row.nearest;
      f.had += row.had_stock;
      f.refusals += Object.values(row.refusals as Record<string, number>).reduce((a, b) => a + b, 0);
      fill.set(row.store_id, f);
    }
    const activeStores = stores.filter((s) => s.storeStatus === 'ACTIVE');
    const name = new Map(stores.map((s) => [s.storeId, s.storeName]));
    const rows = active;
    const all = [...rows, ...history];
    const waiting = rows.filter((r) => r.status === 'PENDING');
    const minutesSince = (iso: string) => Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
    const waitingAt = (storeId: string) => waiting.filter((r) => r.store_id === storeId);
    const byConversation = new Map<string, ReservationRow[]>();
    for (const r of all)
      if (r.conversation_id)
        byConversation.set(r.conversation_id, [...(byConversation.get(r.conversation_id) ?? []), r]);
    const f = panels.funnel;
    // The Overview tiles (frontend overview.ts kpis): online = ONLINE + ALTERNATIVE; conversion =
    // purchases ÷ finished journeys (a recorded outcome).
    const online = f.outcomes.ONLINE + f.outcomes.ALTERNATIVE;
    const purchases = f.outcomes.OFFLINE + online;
    const finished = purchases + f.outcomes.NONE;
    return {
      brand_name: brand?.name ?? 'your brand',
      period_days: scope.days,
      synthetic_history_included: scope.includeHistory,
      totals: {
        shopper_intents: f.intents,
        new_conversations: f.conversations,
        store_recommendations: f.store_recommendations,
        holds: f.reservations,
        pickups_collected_in_store: f.completed,
        online_orders: online,
        purchases,
        finished_journeys: finished,
        conversion_percent: finished === 0 ? null : Math.round((purchases / finished) * 100),
        journeys_without_purchase: f.outcomes.NONE,
        value_of_purchases: f.value.amount,
        currency: f.value.currency,
      },
      stores: activeStores.map((s) => {
        const x = fill.get(s.storeId);
        return {
          store_id: s.storeId,
          name: s.storeName,
          area: s.area ?? null,
          status: s.storeStatus,
          has_store_admin: Boolean(s.retailAdminUserId),
          sku_count: s.skuCount,
          stock_age_hours: s.stockUpdatedAt
            ? Math.round((now.getTime() - Date.parse(s.stockUpdatedAt)) / 3_600_000)
            : null,
          nearest_lookups: x?.nearest ?? 0,
          had_stock: x?.had ?? 0,
          fill_rate_percent: x && x.nearest > 0 ? Math.round((x.had / x.nearest) * 100) : null,
          refusals: x?.refusals ?? 0,
        };
      }),
      stores_count: activeStores.length,
      unmet_demand: panels.unmet_demand
        .map((u) => ({ product: u.label, area: titleCase(u.area), count: u.count }))
        .slice(0, 8),
      weekday_reading: panels.weekday.reading
        ? { kind: panels.weekday.reading.kind, text: panels.weekday.reading.text }
        : null,
      suggestions: panels.suggestions.map((s) => ({ rule: s.rule, text: s.text, store_id: s.store_id })),
      holds_now: {
        active: rows.length,
        waiting_for_store: waiting.length,
        oldest_waiting_minutes: waiting.length ? Math.max(...waiting.map((r) => minutesSince(r.created_at))) : null,
        expiry_window_minutes: EXPIRY_WINDOW_MINUTES,
        expiring_within_60_min: rows.filter(
          (r) => Date.parse(r.expires_at) - now.getTime() <= EXPIRY_WINDOW_MINUTES * 60_000,
        ).length,
        by_store: [...new Set(rows.map((r) => r.store_id))].map((id) => ({
          store: name.get(id) ?? 'a store',
          waiting: rows.filter((r) => r.store_id === id && r.status === 'PENDING').length,
          oldest_waiting_minutes: waitingAt(id).length
            ? Math.max(...waitingAt(id).map((r) => minutesSince(r.created_at)))
            : null,
          confirmed: rows.filter((r) => r.store_id === id && r.status === 'CONFIRMED').length,
          ready: rows.filter((r) => r.store_id === id && r.status === 'READY').length,
        })),
      },
      conversations_now: {
        total: conversations.length,
        with_hold: conversations.filter((c) => byConversation.has(c.conversation.conversationId)).length,
        without_hold: conversations.filter((c) => !byConversation.has(c.conversation.conversationId)).length,
        refused_by_store: all.filter((r) => r.cancelled_by === 'RETAILER').length,
        with_person: conversations.filter((c) => c.conversation.humanHandoff).length,
      },
    };
  }

  /** The drawer: a question about the brand, asked on `page`, about what the page shows (`scope`). */
  async ask(
    principal: BrandPrincipal,
    question: string,
    page: ConsolePage,
    scope: PackScope = DEFAULT_SCOPE,
  ): Promise<AssistantAnswer> {
    const started = Date.now();
    const pack = await this.pack(principal, scope);
    return this.deps.runner.run({
      ...this.base(principal),
      surface: 'ASK',
      task: 'ANSWER',
      page,
      question,
      data: pack,
      // One Gemini call when the pack covers the question; a tool only for what it does not hold.
      tools: this.tools(principal, pack, scope).filter((t) =>
        brandToolsFor(question, pack).includes(t.declaration.name),
      ),
      quick: () => quickAnswer(question, page, pack),
      started,
    });
  }

  /**
   * The Overview brief for the period and synthetic-history choice on screen: cached for 10
   * minutes per brand and choice (1 minute when it fell back to the rules).
   */
  async brief(
    principal: BrandPrincipal,
    options: { refresh?: boolean; scope?: PackScope } = {},
  ): Promise<AssistantAnswer> {
    const scope = options.scope ?? DEFAULT_SCOPE;
    const key = `${principal.brandId}|${scope.days}|${scope.includeHistory}`;
    const cached = this.briefs.get(key);
    if (!options.refresh && cached) return cached;
    const started = Date.now();
    const pack = await this.pack(principal, scope);
    const value = await this.deps.runner.run({
      ...this.base(principal),
      surface: 'BRIEF',
      task: 'BRIEF',
      page: 'OVERVIEW' as ConsolePage,
      data: pack,
      quick: () => quickBrief(pack), // the pack covers the brief: one call, no tools
      started,
    });
    this.briefs.set(key, value);
    return value;
  }

  /** Forget a brand's cached brief (Reset demo). */
  forget(brandId: string) {
    this.briefs.forget(`${brandId}|`);
  }

  /**
   * A conversation's summary (and handoff brief): an AI one is stored on the conversation and
   * reused until a new message arrives; a quick summary is not stored, so the next open retries.
   */
  async conversationSummary(principal: BrandPrincipal, conversationId: string): Promise<AssistantAnswer> {
    const started = Date.now();
    const brandId = principal.brandId;
    const detail = await this.deps.conversations.conversationDetail(brandId, conversationId);
    const pack = conversationPack(detail as unknown as DetailLike);
    const stored = await this.deps.summaries.get(brandId, conversationId);
    if (stored && stored.messageCount === pack.message_count) {
      return {
        answer: stored.summary,
        handoff_brief: pack.handed_to_person ? stored.handoffBrief : null,
        next_action: null,
        used: ['conversation'],
        source: 'AI',
        generated_at: stored.generatedAt,
        latency_ms: Date.now() - started,
      };
    }
    const result = await this.deps.runner.run({
      ...this.base(principal),
      surface: 'CONVERSATION_SUMMARY',
      task: 'SUMMARY',
      page: 'CONVERSATIONS' as ConsolePage,
      data: pack,
      quick: () => quickConversationSummary(pack),
      started,
    });
    const modelName = this.deps.runner.modelName;
    if (result.source === 'AI' && modelName) {
      await this.deps.summaries.put(brandId, conversationId, {
        summary: result.answer,
        handoffBrief: result.handoff_brief,
        messageCount: pack.message_count,
        generatedAt: result.generated_at,
        model: modelName,
      });
    }
    return result;
  }

  /** The two read tools, over this brand only, built from the pack and the brand's own records. */
  private tools(principal: BrandPrincipal, pack: BrandPack, scope: PackScope): AssistantTool[] {
    const getStore: AssistantTool = {
      declaration: {
        name: 'get_store',
        description:
          "One store's details (stock age, fill rate, refusals) and its holds right now. No shopper details.",
        parameters: {
          type: 'object',
          properties: { store_id: { type: 'string', description: 'A store_id from data.stores' } },
          required: ['store_id'],
        },
      },
      run: async (args) => {
        const store_id = String(args.store_id ?? '');
        const store = pack.stores.find((s) => s.store_id === store_id);
        if (!store) return { error: 'STORE_NOT_FOUND' };
        const holds = (
          (await this.deps.reservations.listFor(principal, {
            view: 'active',
            storeId: store_id,
            limit: 50,
          })) as unknown as ReservationRow[]
        )
          .filter((r) => scope.includeHistory || !r.demo_history)
          .map((r) => ({
            product: `${r.product_title ?? ''} ${r.variant_title ?? ''}`.trim(),
            status: r.status,
            minutes_since_created: Math.max(0, Math.round((this.now().getTime() - Date.parse(r.created_at)) / 60_000)),
          }));
        return { store, holds };
      },
    };
    const listConversations: AssistantTool = {
      declaration: {
        name: 'list_conversations',
        description: 'Recent conversations with what happened (product, hold, refusal, handoff). No shopper details.',
        parameters: {
          type: 'object',
          properties: {
            without_hold: { type: 'boolean' },
            refused_by_store: { type: 'boolean' },
            with_person: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 10 },
          },
        },
      },
      run: async (args) => {
        const filter = args as {
          without_hold?: boolean;
          refused_by_store?: boolean;
          with_person?: boolean;
          limit?: number;
        };
        const { active, history, conversations: list } = await this.records(principal, scope);
        const holds = [...active, ...history];
        const rows = list.map((c) => {
          const mine = holds.filter((r) => r.conversation_id === c.conversation.conversationId);
          return {
            conversation_id: c.conversation.conversationId,
            product: c.intent?.productTitle
              ? `${c.intent.productTitle}${c.intent.variantTitle ? ` ${c.intent.variantTitle}` : ''}`
              : null,
            had_hold: mine.length > 0,
            hold_status: mine.at(-1)?.status ?? null,
            refused_by_store: mine.some((r) => r.cancelled_by === 'RETAILER'),
            with_person: c.conversation.humanHandoff,
          };
        });
        return rows
          .filter((r) => (filter.without_hold ? !r.had_hold : true))
          .filter((r) => (filter.refused_by_store ? r.refused_by_store : true))
          .filter((r) => (filter.with_person ? r.with_person : true))
          .slice(0, Math.min(10, Math.max(1, filter.limit ?? 10)));
      },
    };
    return [getStore, listConversations];
  }
}

/** "Expiring soon" on the Reservations page: within the next hour. In the pack as a value so an answer may say "within 60 minutes". */
const EXPIRY_WINDOW_MINUTES = 60;

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

interface ReservationRow {
  store_id: string;
  store_name: string;
  status: string;
  created_at: string;
  expires_at: string;
  conversation_id: string | null;
  cancelled_by: string | null;
  product_title?: string | null;
  variant_title?: string | null;
  demo_history?: boolean;
}

interface DetailLike {
  conversation: { humanHandoff: boolean };
  intent: { productTitle: string | null; variantTitle: string | null; intent: { intentType: string } } | null;
  messages: { direction: string; origin: string; text: string | null }[];
  recommendations: {
    action: string;
    guardrailStatus: string;
    rationaleSummary: string;
    reservation: {
      storeName: string;
      status: string;
      statusHistory: { by?: string | null; reason?: string | null }[];
    } | null;
    trace: { eligible?: { store_id: string; store_name: string }[] } | null;
    targetStoreId: string | null;
  }[];
  outcomes: { purchaseType: string }[];
}

const FROM: Record<string, ConversationPack['messages'][number]['from']> = {
  CUSTOMER: 'SHOPPER',
  AUTOMATED_REPLY: 'ASSISTANT',
  PROACTIVE_FOLLOW_UP: 'FOLLOW_UP',
  RESERVATION_UPDATE: 'STORE',
  HUMAN_AGENT: 'TEAM',
};

/** One conversation for its summary: messages redacted and shortened; decisions; holds; no customer. */
export function conversationPack(d: DetailLike): ConversationPack {
  const storeOf = (r: DetailLike['recommendations'][number]) =>
    r.reservation?.storeName ?? r.trace?.eligible?.find((s) => s.store_id === r.targetStoreId)?.store_name ?? null;
  return {
    product: d.intent?.productTitle
      ? `${d.intent.productTitle}${d.intent.variantTitle ? ` ${d.intent.variantTitle}` : ''}`
      : null,
    intent_type: d.intent?.intent.intentType ?? null,
    handed_to_person: d.conversation.humanHandoff,
    messages: d.messages.slice(-20).map((m) => ({
      from: FROM[m.origin] ?? (m.direction === 'INBOUND' ? 'SHOPPER' : 'ASSISTANT'),
      text: redactPII((m.text ?? '').replace(/\s+/g, ' ').slice(0, 300)),
    })),
    decisions: d.recommendations.slice(-10).map((r) => ({
      action: r.action,
      store: storeOf(r),
      guardrail: r.guardrailStatus,
      reason: redactPII(r.rationaleSummary),
    })),
    holds: d.recommendations
      .filter((r) => r.reservation)
      .map((r) => {
        const cancel = r.reservation!.statusHistory.find((s) => s.by);
        return {
          store: r.reservation!.storeName,
          status: r.reservation!.status,
          cancelled_by: cancel?.by ?? null,
          cancel_reason: cancel?.reason ?? null,
        };
      }),
    outcome: d.outcomes.at(-1)?.purchaseType ?? null,
    message_count: d.messages.length,
  };
}
