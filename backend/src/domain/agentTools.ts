/**
 * Output shapes of the agent tools (docs/05_AI_AGENT_SPEC.md §6). Tool outputs are
 * verified application data in snake_case JSON, so the same objects go to Gemini (L1), to
 * the MockAgentRuntime, to the reply builders and into the decision trace.
 */
import type { ExclusionReason } from './storeTruth.js';

export const READ_TOOLS = [
  'get_product_context',
  'get_brand_policy',
  'get_customer_history',
  'find_nearby_stores',
  'check_store_inventory',
  'get_store_hours',
] as const;
export const WRITE_TOOLS = [
  'create_reservation',
  'cancel_reservation',
  'request_human_handoff',
  'record_customer_intent',
] as const;
export type ReadToolName = (typeof READ_TOOLS)[number];
export type WriteToolName = (typeof WRITE_TOOLS)[number];
export type ToolName = ReadToolName | WriteToolName;
export const isWriteTool = (name: string): name is WriteToolName => (WRITE_TOOLS as readonly string[]).includes(name);

export interface VariantSheet {
  variant_id: string;
  title: string;
  sku: string;
  price: number;
  currency: string;
}

export interface ProductSheet {
  product_id: string;
  title: string;
  description: string;
  category: string | null;
  tags: string[];
  attributes: Record<string, string>;
  variants: VariantSheet[];
  /** The brand's online product page (brand setting), or null. */
  online_url: string | null;
}

export interface ProductContextOutput {
  status: 'FOUND' | 'AMBIGUOUS' | 'NOT_FOUND';
  product: ProductSheet | null;
  /** The resolved variant, when one was asked for or matched. */
  variant_id: string | null;
  /** Verified alternatives (same `concern` attribute). */
  alternatives: ProductSheet[];
  candidates: { product_id: string; title: string }[];
}

export interface BrandPolicyOutput {
  reservations_enabled: boolean;
  hold_minutes: number;
  max_quantity_per_reservation: number;
  handoff_enabled: boolean;
  online_purchase_available: boolean;
  payment: 'PAY_AT_STORE';
}

export interface StoreOption {
  store_id: string;
  store_name: string;
  locality: string;
  address: string | null;
  city: string;
  latitude: number;
  longitude: number;
  timezone: string;
  distance_km: number;
  open_until: string | null;
  available_quantity: number;
  offline_price: number | null;
}

export interface ExcludedStoreView {
  store_id: string;
  store_name: string;
  locality: string;
  reason: ExclusionReason;
  distance_km: number | null;
  timezone: string | null;
}

export interface VariantView {
  variant_id: string;
  product_id: string;
  product_title: string;
  variant_title: string;
  sku: string;
  price: number;
  currency: string;
  online_url: string | null;
}

export interface NearbyStoresOutput {
  status: 'OK' | 'LOCATION_REQUIRED' | 'AMBIGUOUS_AREA' | 'UNKNOWN_VARIANT';
  variant: VariantView | null;
  origin: { source: 'SHARED' | 'LOCALITY'; approximate: boolean; locality: string | null } | null;
  /** Coordinates of the origin (rounded); the trace redacts them. */
  origin_point: { latitude: number; longitude: number } | null;
  radius_km: number;
  skipped_stores: string[];
  eligible: StoreOption[];
  excluded: ExcludedStoreView[];
  ambiguous_areas: string[];
}

export interface StoreInventoryOutput {
  status: 'OK' | 'UNKNOWN_STORE';
  store_id: string;
  variant_id: string;
  available_quantity: number;
  availability_status: string;
}

export interface StoreHoursOutput {
  status: 'OK' | 'UNKNOWN_STORE';
  store_id: string;
  timezone: string | null;
  open_now: boolean;
  open_until: string | null;
  today: string | null;
}

export interface CustomerHistoryOutput {
  active_reservations: {
    reservation_id: string;
    store_id: string;
    store_name: string;
    variant_id: string;
    status: string;
    expires_at: string;
  }[];
  reservation_counts: Record<string, number>;
}

export interface ReservationView {
  reservation_id: string;
  status: string;
  store_id: string;
  variant_id: string;
  quantity: number;
  pickup_code: string;
  created_at: string;
  expires_at: string;
  customer_eta: string | null;
}

export interface ReservationToolOutput {
  status: 'CREATED' | 'REPLAYED' | 'REJECTED' | 'CANCELLED' | 'NOT_FOUND' | 'INVALID_TRANSITION';
  reason: string | null;
  reservation: ReservationView | null;
  store: {
    store_id: string;
    store_name: string;
    address: string | null;
    city: string;
    latitude: number | null;
    longitude: number | null;
    timezone: string | null;
  } | null;
  variant: VariantView | null;
}

export interface HandoffOutput {
  human_handoff: true;
}

export interface IntentRefinementOutput {
  intent_id: string | null;
  intent_type: string;
  changed: boolean;
}
