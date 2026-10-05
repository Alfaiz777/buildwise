/** Platform Console response shapes and words (Change 16, UI-5). Aggregates only. */

export interface Onboarding {
  brand_admin_provisioned: boolean;
  catalog: { synced: boolean; failed: boolean; last_sync_at: string | null; product_count: number };
  stores: { total: number; with_stock: number };
  sku_mapping: { auto_matched: number; needs_attention: number };
  retail_admins: { provisioned: number; stores_with_retailer: number };
  channel: { simulator: boolean; whatsapp_number_configured: boolean };
}
export interface Brand {
  brand_id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  created_at: string | null;
  brand_admin_user_id: string | null;
  last_activity_at?: string | null;
  onboarding?: Onboarding;
}

export interface Money {
  amount: number;
  currency: string;
}
export interface Aggregate {
  stores_total: number;
  stores_live: number;
  holds: number;
  pickups: number;
  offline_value: Money;
  online_orders: number;
  online_value: Money;
  completion_pct: number | null;
  fill_pct: number | null;
  unmet_demand: number;
  follow_ups_sent: number;
}
export interface NetworkResponse {
  period: { days: number; from: string; to: string };
  demo_history: { included: boolean; records: number };
  totals: Aggregate & { brands_active: number; retailers: number };
  brands: (Aggregate & {
    brand_id: string;
    name: string;
    status: string;
    stores_flagged: number;
    last_activity_at: string | null;
  })[];
}

export type StoreFlag =
  'NO_STOCK_UPLOAD' | 'STALE_STOCK' | 'NO_STORE_ADMIN' | 'LOW_FILL_RATE' | 'HIGH_REFUSAL_RATE' | 'STALE_HOLDS';
export interface StoreRow {
  store_id: string;
  store_name: string;
  city: string;
  status: string;
  store_admin_provisioned: boolean;
  stock: { sku_count: number; freshness: 'FRESH' | 'STALE' | 'NONE'; updated_at: string | null };
  holds: number;
  completed: number;
  refused: Record<string, number>;
  expired: number;
  completion_pct: number | null;
  nearest_lookups: number;
  fill_pct: number | null;
  active_holds: number;
  stale_holds: number;
  flags: StoreFlag[];
}
export interface BrandNetwork {
  brand_id: string;
  name: string;
  status: string;
  period: { days: number; from: string; to: string };
  demo_history: { included: boolean };
  retailers: { retailer_id: string; name: string; status: string; stores: StoreRow[] }[];
  unassigned_stores: StoreRow[];
}

export interface AuditEvent {
  audit_id: string;
  actor_role?: string;
  action: string;
  target_brand_id: string | null;
  target_brand_name?: string | null;
  target_type?: string;
  target_id: string;
  result?: 'SUCCESS' | 'DENIED' | 'FAILED';
  reason_code?: string | null;
  timestamp: string | null;
}

/** Health flags in words, each with what it means. */
export const FLAG_TEXT: Record<StoreFlag, { label: string; explain: string }> = {
  NO_STOCK_UPLOAD: { label: 'No stock upload', explain: 'The brand has not imported any stock for this store.' },
  STALE_STOCK: { label: 'Stale stock', explain: "The store's stock is older than the brand's freshness window." },
  NO_STORE_ADMIN: { label: 'No Store Admin', explain: 'Nobody can confirm holds at this store yet.' },
  LOW_FILL_RATE: {
    label: 'Low fill rate',
    explain: 'Often the nearest store, but had what shoppers asked for less than half the time.',
  },
  HIGH_REFUSAL_RATE: { label: 'High refusal rate', explain: 'Refused at least 1 in 5 of its finished holds.' },
  STALE_HOLDS: { label: 'Stale holds', explain: 'Holds past their expiry, or new holds unconfirmed for 30 minutes.' },
};

export const ACTION_TEXT: Record<string, string> = {
  BRAND_CREATED: 'Brand created',
  BRAND_SUSPENDED: 'Brand suspended',
  BRAND_REACTIVATED: 'Brand reactivated',
  BRAND_ADMIN_PROVISIONED: 'Brand Admin provisioned',
};

export const REFUSAL_WORDS: Record<string, string> = {
  NOT_ACTUALLY_IN_STOCK: 'not in stock',
  DAMAGED: 'damaged',
  STORE_CLOSING_EARLY: 'closing early',
  OTHER: 'other',
};

/** The brand's next onboarding step, in one sentence (its first unfinished item). */
export function nextStep(b: Brand): string {
  const o = b.onboarding;
  if (b.status === 'SUSPENDED') return 'Suspended — reactivate to continue.';
  if (!b.brand_admin_user_id && !o?.brand_admin_provisioned) return 'Provision its Brand Admin.';
  if (!o) return 'Waiting for the brand to set up.';
  if (!o.catalog.synced) {
    return o.catalog.failed
      ? 'The catalogue sync failed — the brand should retry it.'
      : 'Waiting for the brand to sync its catalogue.';
  }
  if (o.stores.with_stock === 0) return 'Waiting for the brand to import store stock.';
  if (o.sku_mapping.needs_attention > 0)
    return `Waiting for the brand to fix ${o.sku_mapping.needs_attention} SKU mapping(s).`;
  if (o.retail_admins.stores_with_retailer > 0 && o.retail_admins.provisioned < o.retail_admins.stores_with_retailer) {
    return 'Waiting for the brand to provision Store Admins.';
  }
  return 'Live.';
}

export const pctText = (p: number | null) => (p === null ? '—' : `${p}%`);
