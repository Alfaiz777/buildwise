/**
 * "Ask Qwikspot" for the Platform Console (L7, docs/05 §18.2): the platform agent.
 *
 * - PLATFORM_ADMIN only (the route's scope). Read-only: it never creates a brand, provisions an
 *   admin or changes a status — it names the page or button that does.
 * - The pack is built ONLY from what PlatformAdminService already returns to the Platform pages
 *   (overview → /brands, network → /network, brandNetwork → /brands/:id/network, auditView →
 *   /audit), so its totals and flag counts are the pages' own. Totals and flags only (docs/07
 *   §4.2): before anything goes to Gemini the pack is walked for private data and refused if
 *   any is found.
 * - Answers through the shared AssistantRunner (Gemini 17 s inside 20 s, checked; otherwise
 *   the rules "Quick summary").
 */
import type { PlatformPrincipal } from '../domain/principal.js';
import {
  findPrivateData,
  PLATFORM_ASSISTANT_PROMPT,
  PLATFORM_ASSISTANT_PROMPT_VERSION,
  PLATFORM_PAGE_PATHS,
  PlatformAnswerSchema,
  platformAnswerJsonSchema,
  quickPlatformAnswer,
  quickPlatformBrief,
  setupNextStep,
  type PlatformPack,
  type PlatformPage,
} from '../domain/platformAssistant.js';
import { STORE_FLAGS } from '../domain/platformNetwork.js';
import {
  BriefCache,
  DEFAULT_SCOPE,
  type AssistantAnswer,
  type AssistantRunner,
  type AssistantScope,
} from './assistantRunner.js';
import type { PlatformAdminService } from './platformAdminService.js';

export type PlatformAssistantAnswer = AssistantAnswer<PlatformPage>;

/** Platform questions are not about one brand: their ASSISTANT_QUESTION events are kept under this scope. */
export const PLATFORM_EVENT_SCOPE = 'platform';
const AUDIT_EVENTS = 20;

export class PlatformPackError extends Error {}

export class PlatformAssistantService {
  private readonly briefs = new BriefCache<PlatformAssistantAnswer>();

  constructor(
    private readonly deps: {
      runner: AssistantRunner;
      platform: Pick<PlatformAdminService, 'overview' | 'network' | 'brandNetwork' | 'auditView'>;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** The platform pack for the Overview's period and synthetic-history choice. */
  async pack(scope: AssistantScope = DEFAULT_SCOPE): Promise<PlatformPack> {
    const { platform } = this.deps;
    const [overview, network, audit] = await Promise.all([
      platform.overview(),
      platform.network(scope),
      platform.auditView(AUDIT_EVENTS),
    ]);
    const nets = await Promise.all(overview.map((o) => platform.brandNetwork(o.brand.brandId, scope)));
    const now = this.now().getTime();
    const countFlags = (rows: { flags: string[] }[]) =>
      Object.fromEntries(STORE_FLAGS.map((f) => [f, rows.filter((r) => r.flags.includes(f)).length]));
    const allRows = nets.flatMap((n) => [...n.retailers.flatMap((r) => r.stores), ...n.unassigned_stores]);

    const pack: PlatformPack = {
      period_days: scope.days,
      synthetic_history_included: scope.includeHistory,
      totals: network.totals,
      flag_counts: countFlags(allRows),
      brands: overview.map((o, i) => {
        const rows = [...nets[i]!.retailers.flatMap((r) => r.stores), ...nets[i]!.unassigned_stores];
        const row = network.brands.find((b) => b.brand_id === o.brand.brandId);
        const view = {
          status: o.brand.status,
          brand_admin_provisioned: !!o.brand.brandAdminUserId,
          catalog: { synced: o.catalog.synced, failed: o.catalog.failed },
          stores: { with_stock: o.stores.withStock },
          sku_mapping: { needs_attention: o.mapping.needsAttention },
          retail_admins: {
            provisioned: o.retailAdmins.provisioned,
            stores_with_retailer: o.retailAdmins.storesWithRetailer,
          },
        };
        const { brand_id: _id, name: _name, status: _status, last_activity_at: _last, ...numbers } = row ?? {};
        return {
          name: o.brand.name,
          status: o.brand.status,
          setup_next_step: setupNextStep(view),
          setup: {
            brand_admin_provisioned: view.brand_admin_provisioned,
            catalog_synced: o.catalog.synced,
            catalog_failed: o.catalog.failed,
            products: o.catalog.productCount,
            stores_total: o.stores.total,
            stores_with_stock: o.stores.withStock,
            sku_mappings_need_attention: o.mapping.needsAttention,
            store_admins_provisioned: o.retailAdmins.provisioned,
            stores_with_retailer: o.retailAdmins.storesWithRetailer,
          },
          last_activity_at: o.lastActivityAt,
          network: numbers,
          flag_counts: countFlags(rows),
          flagged_stores: rows
            .filter((s) => s.flags.length > 0)
            .slice(0, 15)
            .map((s) => ({
              store: s.store_name,
              city: s.city,
              flags: s.flags,
              stock: s.stock.freshness,
              stock_updated_hours_ago: s.stock.updated_at
                ? Math.max(0, Math.round((now - Date.parse(s.stock.updated_at)) / 3_600_000))
                : null,
            })),
        };
      }),
      audit: audit.map((e) => ({
        action: e.action,
        actor_role: e.actorRole,
        target_brand: e.targetBrandName,
        target_type: e.targetType,
        result: e.result,
        reason: e.reasonCode,
        at: e.timestamp,
      })),
    };
    // Fail closed: a pack with private data is never sent anywhere (docs/07 §4.2).
    const leaks = findPrivateData(pack);
    if (leaks.length)
      throw new PlatformPackError(`platform pack holds private data at ${leaks.slice(0, 3).join(', ')}`);
    return pack;
  }

  private base() {
    return {
      console: 'platform' as const,
      brandId: PLATFORM_EVENT_SCOPE,
      prompt: PLATFORM_ASSISTANT_PROMPT,
      promptVersion: PLATFORM_ASSISTANT_PROMPT_VERSION,
      schema: PlatformAnswerSchema,
      answerSchema: platformAnswerJsonSchema(),
      pathOf: (page: PlatformPage) => PLATFORM_PAGE_PATHS[page],
    };
  }

  /** The drawer: a question about the platform, asked on `page`. */
  async ask(
    _principal: PlatformPrincipal,
    question: string,
    page: PlatformPage,
    scope: AssistantScope = DEFAULT_SCOPE,
  ): Promise<PlatformAssistantAnswer> {
    const started = Date.now();
    const pack = await this.pack(scope);
    return this.deps.runner.run({
      ...this.base(),
      surface: 'ASK',
      task: 'ANSWER',
      page,
      question,
      data: pack,
      quick: () => quickPlatformAnswer(question, page, pack),
      started,
    });
  }

  /** "Network today": cached 10 minutes per choice (1 minute after a Quick summary). */
  async brief(options: { refresh?: boolean; scope?: AssistantScope } = {}): Promise<PlatformAssistantAnswer> {
    const scope = options.scope ?? DEFAULT_SCOPE;
    const key = `${PLATFORM_EVENT_SCOPE}|${scope.days}|${scope.includeHistory}`;
    const cached = this.briefs.get(key);
    if (!options.refresh && cached) return cached;
    const started = Date.now();
    const pack = await this.pack(scope);
    const value = await this.deps.runner.run({
      ...this.base(),
      surface: 'BRIEF',
      task: 'BRIEF',
      page: 'HOME' as PlatformPage,
      data: pack,
      quick: () => quickPlatformBrief(pack),
      started,
    });
    this.briefs.set(key, value);
    return value;
  }
}
