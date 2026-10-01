/**
 * InsightsReader (docs/00 §11.8 Change 13, F8): raw, brand-scoped records for a period.
 * Firestore serves it now; in L2 a BigQuery reader can serve the same contract, so the
 * insight calculations and the UI do not change.
 */
import type { InsightRows } from '../domain/insights.js';

export interface InsightsQuery {
  fromIso: string;
  toIso: string;
  /** Inclusive range [fromIso, toIso]. false → documents marked demo_history are left out. */
  includeHistory: boolean;
}

export interface InsightsReader {
  read(brandId: string, query: InsightsQuery): Promise<{ rows: InsightRows; historyRecords: number }>;
}
