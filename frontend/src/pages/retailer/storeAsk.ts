import type { AskConfig } from '../brand/askQwikspot';

/**
 * L6 "Ask Qwikspot" in the Store Console: the same drawer as the Brand Console, asking the store
 * agent about the signed-in Retail Admin's own store only (POST /api/retail/stores/:id/assistant).
 */

export type StorePage = 'TODAY' | 'HISTORY' | 'STOCK' | 'DEMAND';

/** The page a Store Console path belongs to. */
export function storePageOf(pathname: string): StorePage {
  if (pathname.startsWith('/store/history')) return 'HISTORY';
  if (pathname.startsWith('/store/stock')) return 'STOCK';
  if (pathname.startsWith('/store/demand')) return 'DEMAND';
  return 'TODAY';
}

/** The same four questions on every store page (docs/05 §18). */
export const STORE_QUESTIONS = [
  'How is my store doing this week?',
  'Which holds are waiting for me?',
  "What are shoppers near me asking for that I don't have?",
  'What should I stock up before Saturday?',
];

/** Where each part of the store data an answer used is shown in the Store Console. */
const STORE_SOURCES: Record<string, { label: string; to: string }> = {
  totals: { label: 'Today', to: '/store' },
  now: { label: 'Today', to: '/store' },
  waiting_holds: { label: 'Today', to: '/store' },
  stock_attention: { label: 'Stock', to: '/store/stock' },
  demand_near_you: { label: 'Demand', to: '/store/demand' },
  busiest_weekdays: { label: 'Demand', to: '/store/demand' },
  suggestions: { label: 'Demand', to: '/store/demand' },
  refusals: { label: 'History', to: '/store/history' },
};

export const storeAsk = (storeId: string): AskConfig => ({
  askPath: `/api/retail/stores/${encodeURIComponent(storeId)}/assistant`,
  pageOf: storePageOf,
  suggestions: () => STORE_QUESTIONS,
  sourceLinks: STORE_SOURCES,
  dataOf: "your store's",
  placeholder: 'Ask about your holds, stock or demand…',
});

export const storeBriefPath = (storeId: string) => `/api/retail/stores/${encodeURIComponent(storeId)}/assistant/brief`;
