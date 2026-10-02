/**
 * Demo data ports (Change 14, G4 — Reset demo). DemoResetService decides WHAT is reset and
 * rebuilt; the store only knows how to delete and write documents. Nothing here is wired
 * unless DEMO_MODE is on.
 */
import type {
  CommerceEventRecord,
  ConversationRecord,
  IntentRecord,
  RecommendationRecord,
} from './conversationRepositories.js';
import type { OutcomeRecord } from './outcomes.js';
import type { ReservationRecord } from './reservations.js';

/** Synthetic history records (application/demoHistory.ts generates them). */
export interface DemoHistory {
  customerRefs: string[];
  intents: IntentRecord[];
  conversations: ConversationRecord[];
  recommendations: RecommendationRecord[];
  events: CommerceEventRecord[];
  reservations: ReservationRecord[];
  outcomes: OutcomeRecord[];
  /** Hashes of attribution refs used by the synthetic attributed orders. */
  attributionRefs: {
    refHash: string;
    intentId: string;
    conversationId: string;
    recommendationId: string;
    createdAt: string;
    expiresAt: string;
  }[];
}

/**
 * Everything a reset clears for ONE brand: customers and their identities, visitors,
 * intents, conversations (with messages), recommendations, reservations, outcomes,
 * commerce events, attribution refs, stock, imports, the catalogue, mappings and
 * connections — plus that brand's intent tokens and webhook receipts.
 * Kept: the brand document, retailers, stores (and their Retail Admin), users, audit.
 */
export const DEMO_RESET_COLLECTIONS = [
  'customers',
  'channelIdentities',
  'webVisitors',
  'customerIntents',
  'conversations',
  'aiRecommendations',
  'reservations',
  'outcomes',
  'commerceEvents',
  'attributionRefs',
  'retailInventory',
  'retailImports',
  'products',
  'productVariants',
  'productMappings',
  'connections',
] as const;

export interface DemoDataStore {
  /** Deletes DEMO_RESET_COLLECTIONS of `brandId` (and its top-level tokens / receipts). Counts per collection. */
  wipe(brandId: string): Promise<Record<string, number>>;
  /** Replaces brand.settings. */
  setSettings(brandId: string, settings: Record<string, unknown>): Promise<void>;
  /**
   * Writes synthetic history (customers already created through the identity path) and
   * flags every document `demo_history: true`. Counts per collection.
   */
  writeHistory(brandId: string, history: DemoHistory, customerIds: string[]): Promise<Record<string, number>>;
}

/** Read-only access to bundled fixtures (backend/fixtures, copied into the container image). */
export interface FixtureSource {
  read(path: string): Promise<Buffer>;
}
