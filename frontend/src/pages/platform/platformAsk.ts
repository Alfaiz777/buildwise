import type { AskConfig } from '../brand/askQwikspot';

/**
 * L7 "Ask Qwikspot" in the Platform Console: the same drawer as the Brand and Store Consoles,
 * asking the platform agent (POST /api/platform/assistant) about brand and store totals and
 * health flags only — never a brand's customers.
 */

export type PlatformPage = 'HOME' | 'BRANDS' | 'NETWORK' | 'AUDIT' | 'SYSTEM';

/** The page a Platform Console path belongs to. */
export function platformPageOf(pathname: string): PlatformPage {
  if (pathname.startsWith('/platform/brands')) return 'BRANDS';
  if (pathname.startsWith('/platform/network')) return 'NETWORK';
  if (pathname.startsWith('/platform/audit')) return 'AUDIT';
  if (pathname.startsWith('/platform/system')) return 'SYSTEM';
  return 'HOME';
}

/** The same four questions on every platform page (docs/05 §18). */
export const PLATFORM_QUESTIONS = [
  'Which brands need attention?',
  "Which brand's setup is incomplete?",
  'Which stores have stock data older than a day?',
  'What changed in the audit log today?',
];

/** Where each part of the platform data an answer used is shown in the Platform Console. */
const PLATFORM_SOURCES: Record<string, { label: string; to: string }> = {
  totals: { label: 'Overview', to: '/platform' },
  brands: { label: 'Brands', to: '/platform/brands' },
  setup: { label: 'Brands', to: '/platform/brands' },
  flag_counts: { label: 'Retail network', to: '/platform/network' },
  flagged_stores: { label: 'Retail network', to: '/platform/network' },
  network: { label: 'Retail network', to: '/platform/network' },
  audit: { label: 'Audit log', to: '/platform/audit' },
};

export const PLATFORM_ASK: AskConfig = {
  askPath: '/api/platform/assistant',
  pageOf: platformPageOf,
  suggestions: () => PLATFORM_QUESTIONS,
  sourceLinks: PLATFORM_SOURCES,
  dataOf: "the platform's",
  placeholder: 'Ask about brands, setup, store health or the audit log…',
};

export const PLATFORM_BRIEF_PATH = '/api/platform/assistant/brief';
