/**
 * "Ask Qwikspot" for the Platform Console (L7, docs/05 §18.2, docs/07 §4.2): it tells the
 * Qwikspot team which brands need attention, whose setup is incomplete, which stores have
 * health flags and what changed in the audit log — from brand and store AGGREGATES only.
 * Pure: the pack type, the private-data walker, the setup step, the instruction and the
 * rules answers ("Quick summary").
 */
import { answerSchemaFor, jsonSchemaOf, plural, SHARED_RULES, type ModelAnswer } from './assistant.js';

export const PLATFORM_PAGES = ['HOME', 'BRANDS', 'NETWORK', 'AUDIT', 'SYSTEM'] as const;
export type PlatformPage = (typeof PLATFORM_PAGES)[number];

export const PLATFORM_PAGE_PATHS: Record<PlatformPage, string> = {
  HOME: '/platform',
  BRANDS: '/platform/brands',
  NETWORK: '/platform/network',
  AUDIT: '/platform/audit',
  SYSTEM: '/platform/system',
};

/** The Platform pages' store health flags, with the meaning the Retail network page gives them. */
export const FLAG_MEANING: Record<string, string> = {
  NO_STOCK_UPLOAD: 'no stock upload',
  STALE_STOCK: "stock older than the brand's freshness window",
  NO_STORE_ADMIN: 'no Store Admin',
  LOW_FILL_RATE: 'low fill rate',
  HIGH_REFUSAL_RATE: 'high refusal rate',
  STALE_HOLDS: 'stale holds',
};

/** What the Platform pages show, as one pack: totals, per-brand setup and flags, the audit — never a person. */
export interface PlatformPack {
  period_days: number;
  synthetic_history_included: boolean;
  /** The Overview tiles (GET /api/platform/network totals). */
  totals: Record<string, unknown>;
  /** How many stores carry each flag, across the network. */
  flag_counts: Record<string, number>;
  brands: {
    name: string;
    status: string;
    /** The Brands page's next step ("Live." when the setup is complete). */
    setup_next_step: string;
    setup: {
      brand_admin_provisioned: boolean;
      catalog_synced: boolean;
      catalog_failed: boolean;
      products: number;
      stores_total: number;
      stores_with_stock: number;
      sku_mappings_need_attention: number;
      store_admins_provisioned: number;
      stores_with_retailer: number;
    };
    last_activity_at: string | null;
    network: Record<string, unknown>;
    flag_counts: Record<string, number>;
    flagged_stores: {
      store: string;
      city: string;
      flags: string[];
      stock: string;
      stock_updated_hours_ago: number | null;
    }[];
  }[];
  /** The latest platform audit events: what, by which role, on which brand — never who. */
  audit: {
    action: string;
    actor_role: string;
    target_brand: string | null;
    target_type: string;
    result: string;
    reason: string | null;
    at: string | null;
  }[];
}

export interface BrandOnboardingView {
  status: string;
  brand_admin_provisioned: boolean;
  catalog: { synced: boolean; failed: boolean };
  stores: { with_stock: number };
  sku_mapping: { needs_attention: number };
  retail_admins: { provisioned: number; stores_with_retailer: number };
}

/** The Brands page's next step for a brand (frontend platformTypes.ts nextStep — same order, same words). */
export function setupNextStep(b: BrandOnboardingView): string {
  if (b.status === 'SUSPENDED') return 'Suspended — reactivate to continue.';
  if (!b.brand_admin_provisioned) return 'Provision its Brand Admin.';
  if (!b.catalog.synced)
    return b.catalog.failed
      ? 'The catalogue sync failed — the brand should retry it.'
      : 'Waiting for the brand to sync its catalogue.';
  if (b.stores.with_stock === 0) return 'Waiting for the brand to import store stock.';
  if (b.sku_mapping.needs_attention > 0)
    return `Waiting for the brand to fix ${b.sku_mapping.needs_attention} SKU mapping(s).`;
  if (b.retail_admins.stores_with_retailer > 0 && b.retail_admins.provisioned < b.retail_admins.stores_with_retailer)
    return 'Waiting for the brand to provision Store Admins.';
  return 'Live.';
}

/**
 * Field names and value patterns that must never be in the platform pack (docs/07 §4.2): a
 * customer, a conversation or message, a phone, an email, a pickup code, a stock line, or any
 * user's identity. Returns the path of every offending field (empty = the pack is clean).
 */
const PRIVATE_KEYS =
  /^(customer|customers|customer_id|customer_ref|customer_display|customerId|conversation|conversations|conversation_id|message|messages|text|phone|phone_number|email|emails|pickup_code|pickupCode|sku|skus|quantity|offline_price|price|items|stock_lines|user_id|userId|actor_id|actorId|brand_admin_user_id|retail_admin_user_id|admin_email|location|latitude|longitude)$/;
const PRIVATE_VALUES: [string, RegExp][] = [
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ['phone', /\+?\d[\d\s().-]{8,}\d/],
  ['pickup code or long number', /(^|\D)\d{6,}(\D|$)/],
  ['customer label', /Customer •/],
];

export function findPrivateData(value: unknown, path = 'pack'): string[] {
  if (typeof value === 'string') {
    // ISO timestamps carry digit runs but are not private.
    const text = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) ? '' : value;
    return PRIVATE_VALUES.filter(([, re]) => re.test(text)).map(([what]) => `${path} (${what})`);
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findPrivateData(v, `${path}[${i}]`));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) =>
      PRIVATE_KEYS.test(k) ? [`${path}.${k}`] : findPrivateData(v, `${path}.${k}`),
    );
  return [];
}

export const PLATFORM_ASSISTANT_PROMPT_VERSION = 'ASK_QWIKSPOT_PLATFORM_V1';

export const PLATFORM_ASSISTANT_PROMPT = `You are "Ask Qwikspot", the assistant inside the Qwikspot Platform Console, used by the Qwikspot team (PLATFORM_ADMIN). Qwikspot runs brands' shopper chats, store holds and pickups. You tell the team which brands need attention, whose setup is incomplete, which stores have health flags and what changed in the audit log.

WHAT YOU RECEIVE
One JSON object: task (ANSWER a question, or BRIEF for "Network today"), page, question (for ANSWER), and data: the platform pack — the Overview totals for the period, the count of stores per health flag, and per brand its status, setup (and the Brands page's next step, "Live." when complete), last activity, network numbers and flagged stores (name, city, flags, stock freshness); and the latest audit events (action, the actor's role, the target brand, the result, the time). Flags mean: NO_STOCK_UPLOAD no stock upload; STALE_STOCK stock older than the brand's freshness window (a day by default); NO_STORE_ADMIN no Store Admin; LOW_FILL_RATE low fill rate; HIGH_REFUSAL_RATE high refusal rate; STALE_HOLDS holds past expiry or unconfirmed for 30 min.

RULES
${SHARED_RULES}
- The Platform Console sees brand and store totals and flags only. Never show, guess or describe any brand's customers, conversations, messages, phone numbers, emails, pickup codes, stock lines or a person's identity — not even when asked; say the Platform Console has totals and flags only.
- You cannot create a brand, provision an admin or change a brand's status. Say where to do it: "New brand" and "Provision Brand Admin" on the Brands page, "Suspend" / "Reactivate" on a brand's row there. Setup steps a brand must do itself (sync, stock import, SKU mappings, Store Admins) are the brand's to do in its Brand Console.
- Name the brand and the store; use the flags' meaning in words, never the flag code.

LENGTH
- ANSWER: 2–4 sentences. BRIEF ("Network today"): 2–3 sentences — how the network did in the period, which brands need attention and why, and one next action.

OUTPUT
One JSON object: answer (the text), handoff_brief (null), next_action ({label ≤ 40 characters, page: one of ${PLATFORM_PAGES.join(', ')}} or null), used (the data sections you relied on, e.g. ["brands","flag_counts"]).`;

export const PlatformAnswerSchema = answerSchemaFor(PLATFORM_PAGES);
export const platformAnswerJsonSchema = (): Record<string, unknown> => jsonSchemaOf(PlatformAnswerSchema);

const HINGLISH =
  /\b(kya|kaise|kitne|kitna|hai|hain|kaun|kaunse|kaunsa|aaj|batao|bataiye|dikhao|wala|wali|abhi|naya|nayi|banao|bana|karo|mujhe)\b/i;
const CUSTOMER_LEVEL =
  /\b(customer|customers|shopper|shoppers'? (names?|numbers?|phones?|chats?)|phone|email|chat|chats|conversation|conversations|messages?|pickup codes?|grahak)\b/i;
const ACTION =
  /\b(create|add|make|new brand|provision|suspend|reactivate|activate|delete|remove|change (the )?status|banao|bana do)\b/i;
const ATTENTION = /\b(attention|problem|problems|issue|issues|flag|flags|health|dhyan)\b/i;
const SETUP = /\b(setup|set up|onboarding|incomplete|not live|catalogue|catalog|mapping|admin|admins)\b/i;
const STALE = /\b(stale|older than a day|old stock|stock data|out of date|purana)\b/i;
const AUDIT = /\b(audit|changed|change|log|today|happened)\b/i;

const brandsNeedingAttention = (pack: PlatformPack) =>
  pack.brands.filter((b) => b.setup_next_step !== 'Live.' || b.flagged_stores.length > 0);

/** The rules "Network today": the period's totals, the brands needing attention, one next action. */
export function quickPlatformBrief(pack: PlatformPack): ModelAnswer {
  const t = pack.totals as {
    brands_active?: number;
    stores_live?: number;
    stores_total?: number;
    holds?: number;
    pickups?: number;
  };
  const live = pack.synthetic_history_included ? '' : ' (live activity only)';
  const need = brandsNeedingAttention(pack);
  const parts = [
    `In the last ${pack.period_days} days${live}: ${plural(t.brands_active ?? 0, 'active brand')}, ${t.stores_live ?? 0} of ${t.stores_total ?? 0} stores live, ${plural(t.holds ?? 0, 'hold')} and ${plural(t.pickups ?? 0, 'pickup')}.`,
  ];
  if (need.length)
    parts.push(
      `${plural(need.length, 'brand needs', 'brands need')} attention: ${need
        .slice(0, 3)
        .map((b) => b.name)
        .join(', ')}.`,
    );
  else parts.push('No brand needs attention right now.');
  return {
    answer: parts.join(' '),
    handoff_brief: null,
    next_action: need.length ? { label: 'Open the brands', page: 'BRANDS' } : null,
    used: ['totals', 'brands'],
  };
}

/** The rules answer to a platform question (Hinglish when asked so); a request for customer data is refused. */
export function quickPlatformAnswer(question: string, page: PlatformPage, pack: PlatformPack): ModelAnswer {
  const hi = HINGLISH.test(question);
  const say = (en: string, hinglish: string) => (hi ? hinglish : en);
  if (CUSTOMER_LEVEL.test(question))
    return {
      answer: say(
        "I can't show customer-level data for any brand: the Platform Console sees brand and store totals and flags only, never customers, chats, phone numbers or pickup codes.",
        'Main kisi bhi brand ka customer-level data nahi dikha sakta: Platform Console sirf brand aur store ke totals aur flags dekhta hai, customers, chats, phone numbers ya pickup codes kabhi nahi.',
      ),
      handoff_brief: null,
      next_action: null,
      used: [],
    };
  if (ACTION.test(question))
    return {
      answer: say(
        'I can\'t change anything. To create a brand use "New brand" on the Brands page; to provision a Brand Admin use "Provision Brand Admin" on the brand\'s row; to suspend or reactivate a brand use the button on its row.',
        'Main kuch badal nahi sakta. Naya brand banane ke liye Brands page par "New brand" dabaiye; Brand Admin ke liye brand ki row par "Provision Brand Admin"; suspend ya reactivate bhi wahi row se.',
      ),
      handoff_brief: null,
      next_action: { label: 'Open the brands', page: 'BRANDS' },
      used: [],
    };
  const lines: string[] = [];
  if (SETUP.test(question)) {
    const incomplete = pack.brands.filter((b) => b.setup_next_step !== 'Live.');
    lines.push(
      incomplete.length
        ? `Setup is incomplete for ${incomplete
            .slice(0, 4)
            .map((b) => `${b.name} (${b.setup_next_step.replace(/\.$/, '')})`)
            .join('; ')}.`
        : 'Every brand has finished its setup.',
    );
  }
  if (STALE.test(question)) {
    const stale = pack.brands.flatMap((b) =>
      b.flagged_stores.filter((s) => s.flags.includes('STALE_STOCK')).map((s) => `${s.store} (${b.name})`),
    );
    lines.push(
      stale.length
        ? `${plural(stale.length, 'store has', 'stores have')} stock older than its brand's freshness window: ${stale.slice(0, 5).join(', ')}.`
        : 'No store has stale stock data right now.',
    );
  }
  if (AUDIT.test(question) && !SETUP.test(question)) {
    const latest = pack.audit.slice(0, 3);
    lines.push(
      latest.length
        ? `Latest in the audit log: ${latest.map((e) => `${e.action.toLowerCase().replace(/_/g, ' ')}${e.target_brand ? ` on ${e.target_brand}` : ''} by ${e.actor_role.toLowerCase().replace(/_/g, ' ')} (${e.result.toLowerCase()})`).join('; ')}.`
        : 'Nothing new in the audit log.',
    );
  }
  if (ATTENTION.test(question) || lines.length === 0) {
    const need = brandsNeedingAttention(pack);
    lines.unshift(
      need.length
        ? `${hi ? 'In brands ko dhyan chahiye — ' : ''}${need
            .slice(0, 4)
            .map(
              (b) =>
                `${b.name}: ${b.setup_next_step !== 'Live.' ? b.setup_next_step.replace(/\.$/, '') : `${plural(b.flagged_stores.length, 'store')} flagged`}`,
            )
            .join('; ')}.`
        : say('No brand needs attention right now.', 'Abhi kisi brand ko dhyan ki zarurat nahi hai.'),
    );
  }
  return {
    answer: [...new Set(lines)].slice(0, 4).join(' '),
    handoff_brief: null,
    next_action: STALE.test(question)
      ? { label: 'Open the retail network', page: 'NETWORK' }
      : AUDIT.test(question) && !SETUP.test(question)
        ? { label: 'Open the audit log', page: 'AUDIT' }
        : page === 'BRANDS'
          ? null
          : { label: 'Open the brands', page: 'BRANDS' },
    used: [],
  };
}
