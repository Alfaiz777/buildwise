/**
 * "Ask Qwikspot" (L5, docs/05 §18): the brand agent behind the console's AI pieces.
 *
 * - Builds a compact data pack from the same numbers the console shows (Insights panels, the
 *   store network with stock, holds right now, conversations). No shopper identity is in it.
 * - Asks Gemini once (≤ 2 read-tool rounds) within GEMINI_BRAND_DEADLINE_MS (17 s). A slow or
 *   failed answer, or one with a number the data does not contain, is replaced by the rules
 *   summary ("Quick summary"), so every answer arrives within the 20 s ceiling.
 * - Read-only. Brand-scoped by the caller's BRAND principal.
 */
import {
  CONSOLE_PAGES,
  PAGE_PATHS,
  quickAnswer,
  quickBrief,
  quickConversationSummary,
  redactPII,
  ungroundedNumbers,
  type BrandAnswer,
  type BrandPack,
  type ConsolePage,
  type ConversationPack,
} from '../domain/brandAssistant.js';
import type { BrandPrincipal } from '../domain/principal.js';
import type { Logger } from '../lib/logger.js';
import { silentLogger } from '../lib/logger.js';
import type {
  BrandAssistantModel,
  BrandModelInput,
  BrandModelTools,
  ConversationSummaryStore,
} from '../ports/brandAssistant.js';
import type { ConversationQueryService } from './conversationQueryService.js';
import type { InsightsService } from './insightsService.js';
import type { ReservationService } from './reservationService.js';
import type { TenantAdminService } from './tenantAdminService.js';

/** The whole answer, Gemini included, ends within 20 s; Gemini stops at 17 s and the rules answer. */
export const BRAND_ASSISTANT_CEILING_MS = 20_000;
export const GEMINI_BRAND_DEADLINE_MS = 17_000;
/** The Overview brief is written once per period and reused for 10 minutes per brand. */
export const BRIEF_CACHE_MS = 10 * 60_000;
/** A brief that fell back to the rules is retried sooner. */
const QUICK_BRIEF_CACHE_MS = 60_000;
const PERIOD_DAYS = 7;

export type AnswerSource = 'AI' | 'QUICK_SUMMARY';
export type AnswerFailure = 'NO_MODEL' | 'TIMEOUT' | 'ERROR' | 'UNGROUNDED' | 'PII';

export interface AssistantAnswer {
  answer: string;
  handoff_brief: string | null;
  next_action: { label: string; page: ConsolePage; path: string } | null;
  used: string[];
  source: AnswerSource;
  generated_at: string;
  latency_ms: number;
}

class DeadlineExceeded extends Error {}

export class BrandAssistantService {
  private readonly logger: Logger;
  private readonly briefs = new Map<string, { at: number; ttl: number; value: AssistantAnswer }>();

  constructor(
    private readonly deps: {
      insights: InsightsService;
      tenantAdmin: Pick<TenantAdminService, 'listStores'>;
      reservations: Pick<ReservationService, 'listFor'>;
      conversations: Pick<ConversationQueryService, 'listConversations' | 'conversationDetail'>;
      summaries: ConversationSummaryStore;
      brands: { getById(brandId: string): Promise<{ name: string } | null> };
      model?: BrandAssistantModel;
      logger?: Logger;
      now?: () => Date;
      deadlineMs?: number;
    },
  ) {
    this.logger = deps.logger ?? silentLogger;
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** The brand's data pack: what every AI piece and every quick summary is built from. */
  async pack(principal: BrandPrincipal): Promise<BrandPack> {
    const brandId = principal.brandId;
    const now = this.now();
    const [panels, stores, active, history, conversations, brand] = await Promise.all([
      this.deps.insights.panels(brandId, { days: PERIOD_DAYS, includeHistory: true }),
      this.deps.tenantAdmin.listStores(principal),
      this.deps.reservations.listFor(principal, { view: 'active', limit: 500 }),
      this.deps.reservations.listFor(principal, { view: 'history', limit: 500 }),
      this.deps.conversations.listConversations(brandId),
      this.deps.brands.getById(brandId),
    ]);
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
    const rows = active as unknown as ReservationRow[];
    const all = [...rows, ...(history as unknown as ReservationRow[])];
    const waiting = rows.filter((r) => r.status === 'PENDING');
    const minutesSince = (iso: string) => Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
    const byConversation = new Map<string, ReservationRow[]>();
    for (const r of all)
      if (r.conversation_id)
        byConversation.set(r.conversation_id, [...(byConversation.get(r.conversation_id) ?? []), r]);
    const f = panels.funnel;
    return {
      brand_name: brand?.name ?? 'your brand',
      period_days: PERIOD_DAYS,
      totals: {
        shopper_intents: f.intents,
        conversations: f.conversations,
        store_recommendations: f.store_recommendations,
        holds: f.reservations,
        pickups: f.outcomes.OFFLINE,
        online_orders: f.outcomes.ONLINE,
        alternative_purchases: f.outcomes.ALTERNATIVE,
        no_purchase: f.outcomes.NONE,
        sales_value: f.value.amount,
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
          fill_pct: x && x.nearest > 0 ? Math.round((x.had / x.nearest) * 100) : null,
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
        expiring_within_60_min: rows.filter((r) => Date.parse(r.expires_at) - now.getTime() <= 60 * 60_000).length,
        by_store: [...new Set(rows.map((r) => r.store_id))].map((id) => ({
          store: name.get(id) ?? 'a store',
          waiting: rows.filter((r) => r.store_id === id && r.status === 'PENDING').length,
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

  /** The drawer: a question about the brand, asked on `page`. */
  async ask(principal: BrandPrincipal, question: string, page: ConsolePage): Promise<AssistantAnswer> {
    const started = Date.now();
    const pack = await this.pack(principal);
    const tools = this.tools(principal, pack);
    return this.answer(
      'ASK',
      principal.brandId,
      { task: 'ANSWER', page, question, data: pack },
      tools,
      () => quickAnswer(question, page, pack),
      started,
    );
  }

  /** The Overview brief: cached for 10 minutes per brand (1 minute when it fell back to the rules). */
  async brief(principal: BrandPrincipal, options: { refresh?: boolean } = {}): Promise<AssistantAnswer> {
    const cached = this.briefs.get(principal.brandId);
    if (!options.refresh && cached && Date.now() - cached.at < cached.ttl) return cached.value;
    const started = Date.now();
    const pack = await this.pack(principal);
    const value = await this.answer(
      'BRIEF',
      principal.brandId,
      { task: 'BRIEF', page: 'OVERVIEW', data: pack },
      this.tools(principal, pack),
      () => quickBrief(pack),
      started,
    );
    this.briefs.set(principal.brandId, {
      at: Date.now(),
      ttl: value.source === 'AI' ? BRIEF_CACHE_MS : QUICK_BRIEF_CACHE_MS,
      value,
    });
    return value;
  }

  /** Forget a brand's cached brief (Reset demo). */
  forget(brandId: string) {
    this.briefs.delete(brandId);
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
    const result = await this.answer(
      'CONVERSATION_SUMMARY',
      brandId,
      { task: 'SUMMARY', page: 'CONVERSATIONS', data: pack },
      NO_TOOLS,
      () => quickConversationSummary(pack),
      started,
    );
    if (result.source === 'AI' && this.deps.model) {
      await this.deps.summaries.put(brandId, conversationId, {
        summary: result.answer,
        handoffBrief: result.handoff_brief,
        messageCount: pack.message_count,
        generatedAt: result.generated_at,
        model: this.deps.model.model,
      });
    }
    return result;
  }

  /**
   * Gemini within its deadline, checked; otherwise the rules answer. One log line per answer:
   * the surface, who answered, the time, the tools, and why the rules answered (never the text).
   */
  private async answer(
    surface: 'ASK' | 'BRIEF' | 'CONVERSATION_SUMMARY',
    brandId: string,
    input: BrandModelInput,
    tools: BrandModelTools,
    quick: () => BrandAnswer,
    started: number,
  ): Promise<AssistantAnswer> {
    let failure: AnswerFailure | null = null;
    let ai: BrandAnswer | null = null;
    let toolCalls: string[] = [];
    let geminiMs: number | null = null;
    const model = this.deps.model;
    if (!model) failure = 'NO_MODEL';
    else {
      const geminiStarted = Date.now();
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new DeadlineExceeded());
            controller.abort();
          }, this.deps.deadlineMs ?? GEMINI_BRAND_DEADLINE_MS);
        });
        const result = await Promise.race([model.generate(input, tools, controller.signal), deadline]);
        toolCalls = result.toolCalls;
        const text = `${result.answer.answer} ${result.answer.handoff_brief ?? ''} ${result.answer.next_action?.label ?? ''}`;
        if (/\[(phone|email|code)\]|[\w.+-]+@[\w-]+\.\w/.test(text) || /\+?\d[\d\s-]{8,}\d/.test(text)) failure = 'PII';
        else if (ungroundedNumbers(text, input.data, result.toolOutputs, input.question ?? '').length > 0)
          failure = 'UNGROUNDED';
        else ai = result.answer;
      } catch (err) {
        failure = err instanceof DeadlineExceeded ? 'TIMEOUT' : 'ERROR';
      } finally {
        clearTimeout(timer);
        geminiMs = Date.now() - geminiStarted;
      }
    }
    const chosen = ai ?? quick();
    const latency = Date.now() - started;
    this.logger.info('brand_assistant.answer', {
      brand_id: brandId,
      surface,
      page: input.page,
      source: ai ? 'AI' : 'QUICK_SUMMARY',
      failure,
      latency_ms: latency,
      gemini_ms: geminiMs,
      tool_calls: toolCalls,
    });
    const next = chosen.next_action && CONSOLE_PAGES.includes(chosen.next_action.page) ? chosen.next_action : null;
    return {
      answer: chosen.answer,
      handoff_brief: chosen.handoff_brief ?? null,
      next_action: next ? { label: next.label, page: next.page, path: PAGE_PATHS[next.page] } : null,
      used: chosen.used ?? [],
      source: ai ? 'AI' : 'QUICK_SUMMARY',
      generated_at: this.now().toISOString(),
      latency_ms: latency,
    };
  }

  /** The two read tools, over this brand only, built from the pack and the brand's own records. */
  private tools(principal: BrandPrincipal, pack: BrandPack): BrandModelTools {
    return {
      get_store: async ({ store_id }) => {
        const store = pack.stores.find((s) => s.store_id === store_id);
        if (!store) return { error: 'STORE_NOT_FOUND' };
        const holds = (
          (await this.deps.reservations.listFor(principal, {
            view: 'active',
            storeId: store_id,
            limit: 50,
          })) as unknown as ReservationRow[]
        ).map((r) => ({
          product: `${r.product_title ?? ''} ${r.variant_title ?? ''}`.trim(),
          status: r.status,
          minutes_since_created: Math.max(0, Math.round((this.now().getTime() - Date.parse(r.created_at)) / 60_000)),
        }));
        return { store, holds };
      },
      list_conversations: async (filter) => {
        const [list, active, history] = await Promise.all([
          this.deps.conversations.listConversations(principal.brandId),
          this.deps.reservations.listFor(principal, { view: 'active', limit: 500 }),
          this.deps.reservations.listFor(principal, { view: 'history', limit: 500 }),
        ]);
        const holds = [...active, ...history] as unknown as ReservationRow[];
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
  }
}

const NO_TOOLS: BrandModelTools = {
  get_store: async () => ({ error: 'TOOL_NOT_AVAILABLE' }),
  list_conversations: async () => ({ error: 'TOOL_NOT_AVAILABLE' }),
};

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
