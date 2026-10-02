/**
 * Firestore index completeness (M7, live readiness): every multi-field query in the
 * Firestore adapters is classified here, and each one that needs a composite index has it
 * in infrastructure/firebase/firestore.indexes.json. A new multi-field query fails this
 * test until it is classified — so L1 never discovers a missing index in production.
 * (Equality-only filters are served by index merging; a range on one field needs only the
 * automatic single-field index.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ADAPTERS = new URL('../src/adapters/firestore/', import.meta.url);
const INDEXES = new URL('../../infrastructure/firebase/firestore.indexes.json', import.meta.url);

type Need = { composite: [collection: string, ...fields: string[]] } | { none: string };
const QUERIES: Record<string, Need> = {
  "conversationRepositories.ts 'status' == | 'last_event_at' <=": {
    composite: ['customerIntents', 'status', 'last_event_at'],
  },
  "conversationRepositories.ts 'follow_up.status' == | 'follow_up.due_at' <=": {
    composite: ['customerIntents', 'follow_up.status', 'follow_up.due_at'],
  },
  "conversationRepositories.ts 'follow_up.sent_at' >= | 'follow_up.sent_at' <": { none: 'range on one field' },
  "conversationRepositories.ts 'web_session_id' == | 'issued_at' >=": {
    composite: ['intentTokens', 'web_session_id', 'issued_at'],
  },
  "conversationRepositories.ts 'customer_id' == | 'channel' ==": {
    composite: ['conversations', 'customer_id', 'channel'],
  },
  "conversationRepositories.ts 'proposed_at' >= | 'proposed_at' <": { none: 'range on one field' },
  'insightsReader.ts field >= | field <=': { none: 'range on one field (per collection)' },
  "insightsReader.ts 'event_type' == | 'timestamp' >= | 'timestamp' <=": {
    composite: ['commerceEvents', 'event_type', 'timestamp'],
  },
  "reservationRepository.ts 'store_id' == | 'pickup_code' ==": { none: 'equality only (index merging)' },
  "reservationRepository.ts 'status' in | 'expires_at' <=": { composite: ['reservations', 'status', 'expires_at'] },
};

function multiFieldQueries(): string[] {
  const dir = ADAPTERS;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((file) =>
      readFileSync(new URL(file, dir), 'utf8')
        .split(/;\s*\n/)
        .map((statement) => [
          ...[...statement.matchAll(/\.where\(\s*([^,]+),\s*'([^']+)'/g)].map((m) => `${m[1]!.trim()} ${m[2]}`),
          ...[...statement.matchAll(/\.orderBy\(\s*([^,)]+)/g)].map((m) => `order ${m[1]!.trim()}`),
        ])
        .filter((clauses) => clauses.length >= 2)
        .map((clauses) => `${file} ${clauses.join(' | ')}`),
    )
    .sort();
}

describe('Firestore index completeness', () => {
  it('every multi-field query in the adapters is classified', () => {
    expect(multiFieldQueries()).toEqual(Object.keys(QUERIES).sort());
  });

  it('every query that needs a composite index has it in firestore.indexes.json', () => {
    const { indexes } = JSON.parse(readFileSync(INDEXES, 'utf8')) as {
      indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[];
    };
    const declared = new Set(indexes.map((i) => [i.collectionGroup, ...i.fields.map((f) => f.fieldPath)].join(' ')));
    for (const [query, need] of Object.entries(QUERIES)) {
      if ('composite' in need) expect(declared.has(need.composite.join(' ')), query).toBe(true);
    }
  });

  it('Firebase Hosting sends /api/** to the buildwise-api Cloud Run service; everything else is the SPA', () => {
    const firebase = JSON.parse(readFileSync(new URL('../../firebase.json', import.meta.url), 'utf8'));
    expect(firebase.hosting.public).toBe('frontend/dist');
    expect(firebase.hosting.rewrites).toEqual([
      { source: '/api/**', run: { serviceId: 'buildwise-api', region: 'asia-south1' } },
      { source: '**', destination: '/index.html' },
    ]);
  });
});
