/**
 * "Ask Qwikspot" for the Store Console (L6, docs/05 §18): the store agent.
 *
 * - The store comes only from the signed-in Retail Admin (the route checks the path store is
 *   theirs; a store id written in a question is never read). Every number is this store's.
 * - The pack is built from what the store pages show, with the same definitions: the Today
 *   tiles (storeWeekSummary), the queue, the Stock page and "Demand near your store".
 * - Answers through the shared AssistantRunner: Gemini in one call (no tools; the pack covers
 *   the store's questions) within 17 s, checked; otherwise the rules "Quick summary".
 * - Read-only: it never confirms a hold or changes stock — it names the button or page instead.
 */
import type { RetailPrincipal } from '../domain/principal.js';
import {
  LOW_STOCK_AVAILABLE,
  quickStoreAnswer,
  quickStoreBrief,
  STORE_ASSISTANT_PROMPT,
  STORE_ASSISTANT_PROMPT_VERSION,
  STORE_PAGE_PATHS,
  StoreAnswerSchema,
  storeAnswerJsonSchema,
  type StorePack,
  type StorePage,
} from '../domain/storeAssistant.js';
import type { AccountService } from './accountService.js';
import {
  BriefCache,
  DEFAULT_SCOPE,
  type AssistantAnswer,
  type AssistantRunner,
  type AssistantScope,
} from './assistantRunner.js';
import type { InsightsService } from './insightsService.js';
import type { ReservationService } from './reservationService.js';
import { storeWeekSummary } from './storeSummary.js';

export type StoreAssistantAnswer = AssistantAnswer<StorePage>;

interface QueueRow {
  status: string;
  product_title: string | null;
  variant_title: string | null;
  quantity: number;
  customer_display: string;
  created_at: string;
  expires_at: string;
  demo_history?: boolean;
}

export class StoreAssistantService {
  private readonly briefs = new BriefCache<StoreAssistantAnswer>();

  constructor(
    private readonly deps: {
      runner: AssistantRunner;
      account: Pick<AccountService, 'ownStore' | 'storeStock'>;
      reservations: Pick<ReservationService, 'weekSummary' | 'listFor'>;
      insights: Pick<InsightsService, 'storePanel'>;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** One store's pack: its tiles, queue, stock and demand — for the page's period and history choice. */
  async pack(principal: RetailPrincipal, scope: AssistantScope = DEFAULT_SCOPE): Promise<StorePack> {
    const now = this.now().getTime();
    const [store, summary, active, stock, panel] = await Promise.all([
      this.deps.account.ownStore(principal),
      storeWeekSummary(this.deps, principal, scope),
      this.deps.reservations.listFor(principal, { view: 'active', limit: 500 }),
      this.deps.account.storeStock(principal, principal.storeId),
      this.deps.insights.storePanel(principal.brandId, principal.storeId, {
        days: scope.days,
        includeHistory: scope.includeHistory,
      }),
    ]);
    const queue = (active as unknown as QueueRow[]).filter((r) => scope.includeHistory || !r.demo_history);
    const minutes = (iso: string) => Math.round((Date.parse(iso) - now) / 60_000);
    const label = (r: { product_title: string | null; variant_title: string | null }) =>
      `${r.product_title ?? 'a product'}${r.variant_title ? ` ${r.variant_title}` : ''}`;
    const waiting = queue
      .filter((r) => r.status === 'PENDING')
      .map((r) => ({
        product: label(r),
        quantity: r.quantity,
        customer: r.customer_display,
        waited_minutes: Math.max(0, -minutes(r.created_at)),
        expires_in_minutes: Math.max(0, minutes(r.expires_at)),
      }))
      .sort((a, b) => b.waited_minutes - a.waited_minutes);
    const busiest = [...panel.fill_rate]
      .filter((d) => d.nearest > 0)
      .sort((a, b) => b.nearest - a.nearest)
      .slice(0, 3)
      .map((d) => ({ weekday: d.weekday, shoppers_nearest: d.nearest, had_stock: d.had_stock }));
    return {
      store_name: store.storeName,
      area: store.area ?? null,
      period_days: scope.days,
      synthetic_history_included: scope.includeHistory,
      totals: {
        holds: summary.reservations,
        picked_up: summary.completed,
        completion_percent: summary.completion_pct,
        refused: summary.refused,
        expired: summary.expired,
        value_of_pickups: summary.value.amount,
        currency: summary.value.currency,
      },
      now: {
        waiting_for_you: waiting.length,
        confirmed: queue.filter((r) => r.status === 'CONFIRMED').length,
        ready_for_pickup: queue.filter((r) => r.status === 'READY').length,
      },
      waiting_holds: waiting.slice(0, 10),
      stock_attention: stock
        .filter((l) => l.availableQuantity <= LOW_STOCK_AVAILABLE || l.stale)
        .map((l) => ({
          product: label({ product_title: l.productTitle, variant_title: l.variantTitle }),
          available: l.availableQuantity,
          low: l.availableQuantity <= LOW_STOCK_AVAILABLE,
          stale: l.stale,
          updated_hours_ago: l.lastUpdatedAt ? Math.round((now - Date.parse(l.lastUpdatedAt)) / 3_600_000) : null,
        }))
        .sort((a, b) => a.available - b.available)
        .slice(0, 12),
      demand_near_you: panel.missed
        .slice(0, 8)
        .map((m) => ({ product: m.label, weekday: m.weekday, reason: m.reason, count: m.count })),
      refusals: Object.entries(panel.refusals)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => ({ reason, count })),
      busiest_weekdays: busiest,
      suggestions: panel.suggestions.map((s) => s.text),
    };
  }

  private base(principal: RetailPrincipal) {
    return {
      console: 'store' as const,
      brandId: principal.brandId,
      storeId: principal.storeId,
      prompt: STORE_ASSISTANT_PROMPT,
      promptVersion: STORE_ASSISTANT_PROMPT_VERSION,
      schema: StoreAnswerSchema,
      answerSchema: storeAnswerJsonSchema(),
      pathOf: (page: StorePage) => STORE_PAGE_PATHS[page],
    };
  }

  /** The drawer: a question about the own store, asked on `page`, about what the page shows. */
  async ask(
    principal: RetailPrincipal,
    question: string,
    page: StorePage,
    scope: AssistantScope = DEFAULT_SCOPE,
  ): Promise<StoreAssistantAnswer> {
    const started = Date.now();
    const pack = await this.pack(principal, scope);
    return this.deps.runner.run({
      ...this.base(principal),
      surface: 'ASK',
      task: 'ANSWER',
      page,
      question,
      data: pack,
      quick: () => quickStoreAnswer(question, page, pack),
      started,
    });
  }

  /** "Today at your store": cached 10 minutes per store and choice (1 minute after a Quick summary). */
  async brief(
    principal: RetailPrincipal,
    options: { refresh?: boolean; scope?: AssistantScope } = {},
  ): Promise<StoreAssistantAnswer> {
    const scope = options.scope ?? DEFAULT_SCOPE;
    const key = `${principal.brandId}|${principal.storeId}|${scope.days}|${scope.includeHistory}`;
    const cached = this.briefs.get(key);
    if (!options.refresh && cached) return cached;
    const started = Date.now();
    const pack = await this.pack(principal, scope);
    const value = await this.deps.runner.run({
      ...this.base(principal),
      surface: 'BRIEF',
      task: 'BRIEF',
      page: 'TODAY' as StorePage,
      data: pack,
      quick: () => quickStoreBrief(pack),
      started,
    });
    this.briefs.set(key, value);
    return value;
  }

  /** Forget a brand's cached store briefs (Reset demo). */
  forget(brandId: string) {
    this.briefs.forget(`${brandId}|`);
  }
}
