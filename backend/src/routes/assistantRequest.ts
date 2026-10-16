/**
 * "Ask Qwikspot" request parsing and limits, shared by the brand and store routes (docs/06
 * §14.12–14.13): a question of 2–300 characters about a console page, with the page's period
 * and synthetic-history choice; the brief's query; 20 questions per user per minute.
 */
import { z } from 'zod';
import type { AssistantScope } from '../application/assistantRunner.js';
import { AppError, Errors } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';

export function parseAsk<P extends string>(pages: readonly [P, ...P[]], defaultPage: P, body: unknown) {
  const parsed = z
    .object({
      question: z.string().trim().min(2).max(300),
      page: z.enum(pages).default(defaultPage as never),
      /** What the page shows: its period and whether synthetic demo history is included. */
      days: z.union([z.literal(7), z.literal(28)]).default(7),
      include_history: z.boolean().default(true),
    })
    .safeParse(body);
  if (!parsed.success) throw Errors.invalidRequest('Ask a question of 2 to 300 characters.');
  const d = parsed.data;
  return { question: d.question, page: d.page as P, scope: { days: d.days, includeHistory: d.include_history } };
}

export function parseBriefQuery(query: unknown): { refresh: boolean; scope: AssistantScope } {
  const q = z
    .object({
      days: z.enum(['7', '28']).default('7'),
      include_history: z.enum(['true', 'false']).default('true'),
      refresh: z.enum(['true', 'false']).default('false'),
    })
    .safeParse(query);
  if (!q.success) throw Errors.invalidRequest('Period must be 7 or 28 days.');
  return {
    refresh: q.data.refresh === 'true',
    scope: { days: Number(q.data.days) as 7 | 28, includeHistory: q.data.include_history === 'true' },
  };
}

/** 20 questions (or brief refreshes) per user per minute; a 21st → 429 RATE_LIMITED. */
export function assistantLimiter() {
  const perUser = new RateLimiter(20, 60_000);
  return (userId: string) => {
    if (!perUser.hit(userId))
      throw new AppError(429, 'RATE_LIMITED', 'Too many questions in a minute. Try again shortly.', true);
  };
}
