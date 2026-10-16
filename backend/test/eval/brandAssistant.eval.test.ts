/**
 * LIVE evaluation of "Ask Qwikspot" (L5, docs/05 §18) against real Gemini on Vertex AI: every
 * suggested question of the six Brand Console pages, the Overview brief and a handoff
 * conversation's summary, on the Ahmedabad demo world (in memory — the only outside call is
 * to Vertex AI). Prints who answered (AI / Quick summary), the time and the answer, with p50 /
 * p95 for the README, and writes it to BRAND_EVAL_REPORT (default <tmp>/qwikspot-brand-eval.md).
 *
 * Opt-in — skipped unless RUN_GEMINI_EVAL=1 (it needs credentials and costs tokens):
 *   RUN_GEMINI_EVAL=1 VERTEX_PROJECT=<project> npm run eval:brand --workspace backend
 * Optional: EVAL_RUNS (default 1), VERTEX_MODEL, VERTEX_LOCATION.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { GeminiBrandAssistant } from '../../src/adapters/agent/geminiBrandAssistant.js';
import { VertexGeminiClient } from '../../src/adapters/agent/geminiClient.js';
import { BRAND_ASSISTANT_CEILING_MS } from '../../src/application/brandAssistantService.js';
import { DEFAULT_VERTEX_LOCATION, DEFAULT_VERTEX_MODEL } from '../../src/config/env.js';
import type { Logger } from '../../src/lib/logger.js';
import { ahmedabadWorld } from '../ahmedabadWorld.js';
import { bearer } from '../helpers.js';
import { percentile } from './conversationRunner.js';

const ENABLED = process.env.RUN_GEMINI_EVAL === '1';
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
const MODEL = process.env.VERTEX_MODEL || DEFAULT_VERTEX_MODEL;
const LOCATION = process.env.VERTEX_LOCATION || DEFAULT_VERTEX_LOCATION;
const REPORT = process.env.BRAND_EVAL_REPORT || join(tmpdir(), 'qwikspot-brand-eval.md');

/** The drawer's suggested questions (frontend/src/pages/brand/askQwikspot.tsx), per page. */
const QUESTIONS: [page: string, question: string][] = [
  ['OVERVIEW', 'How did we do this week?'],
  ['OVERVIEW', 'What should I fix first?'],
  ['CONVERSATIONS', 'Why did chats end without a hold this week?'],
  ['CONVERSATIONS', 'Show me chats where the shopper refused a store'],
  ['RESERVATIONS', 'Which holds are at risk?'],
  ['RESERVATIONS', 'Which store is slowest to accept?'],
  ['INSIGHTS', 'Which product is losing the most demand?'],
  ['INSIGHTS', 'Compare Satellite and Navrangpura'],
  ['INSIGHTS', 'What should I restock before Saturday?'],
  ['NETWORK', 'Which store needs attention?'],
  ['NETWORK', 'Where should I add a store?'],
  ['SETTINGS', 'What does Qwikspot do automatically for me?'],
];

interface Row {
  surface: string;
  page: string;
  question: string;
  source: string;
  failure: string;
  ms: number;
  answer: string;
}
const rows: Row[] = [];
const oneLine = (t: string) => t.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
const short = (t: string, max = 140) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

describe.skipIf(!ENABLED)(`LIVE Ask Qwikspot — ${MODEL} @ ${LOCATION} (${RUNS} run(s))`, () => {
  afterAll(() => {
    const ms = rows.map((r) => r.ms);
    const ai = rows.filter((r) => r.source === 'AI').length;
    const failures = rows.reduce<Record<string, number>>((acc, r) => {
      if (r.failure) acc[r.failure] = (acc[r.failure] ?? 0) + 1;
      return acc;
    }, {});
    const lines = [
      '',
      `Ask Qwikspot live eval — ${rows.length} answers (${RUNS} run(s)); AI ${ai}, Quick summary ${rows.length - ai}${
        Object.keys(failures).length
          ? ` (${Object.entries(failures)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')})`
          : ''
      }`,
      `Answer time: p50 ${percentile(ms, 0.5)} ms, p95 ${percentile(ms, 0.95)} ms, max ${Math.max(0, ...ms)} ms (ceiling ${BRAND_ASSISTANT_CEILING_MS} ms)`,
      '',
      '| Surface | Page | Question | Source | ms | Answer |',
      '|---|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.surface} | ${r.page} | ${short(oneLine(r.question), 60)} | ${r.source}${r.failure ? ` (${r.failure})` : ''} | ${r.ms} | ${short(oneLine(r.answer))} |`,
      ),
      '',
    ];
    console.log(lines.join('\n'));
    writeFileSync(REPORT, lines.join('\n'));
  });

  it('is configured: a real project (VERTEX_PROJECT) and Application Default Credentials', () => {
    expect(PROJECT, 'set VERTEX_PROJECT').not.toBe('');
    expect(PROJECT.startsWith('demo-')).toBe(false);
  });

  it(
    'every suggested question, the brief and a handoff summary answer within the ceiling, never with PII',
    async () => {
      for (let run = 0; run < RUNS; run++) {
        const answers: Record<string, unknown>[] = [];
        const logger: Logger = {
          debug() {},
          warn() {},
          error() {},
          info: (message, fields) => {
            if (message === 'brand_assistant.answer' && fields) answers.push(fields);
          },
        };
        const client = new VertexGeminiClient({ project: PROJECT, location: LOCATION });
        const s = await ahmedabadWorld({ brandModel: new GeminiBrandAssistant({ client, model: MODEL }), logger });
        // Some activity: two holds (one refused by the store), unmet demand, a handoff with a phone number.
        await s.say('e1', 'I need Vitamin C Glow Serum 30 ml today near Satellite');
        await s.tap('e1', 'hold:st_north_1');
        await s.say('e2', 'I need Vitamin C Glow Serum 50 ml today near Navrangpura');
        await s.say('e3', 'Need Gentle Foaming Cleanser 100 ml near CG Road');
        await s.tap('e3', 'hold:st_north_2');
        await s.say('e4', 'my name is Priya, call me on +91 98765 43210, I want to talk to a person');
        const as = (p: string) => request(s.world.app).get(p).set('Authorization', bearer('admin_a'));
        const post = (p: string, body: object) =>
          request(s.world.app).post(p).set('Authorization', bearer('admin_a')).send(body);
        const record = (surface: string, page: string, question: string, res: request.Response, ms: number) => {
          expect(res.status, `${surface} ${question}`).toBe(200);
          rows.push({
            surface,
            page,
            question,
            source: String(res.body.source),
            failure: String(answers.at(-1)?.failure ?? '').replace('null', ''),
            ms,
            answer: `${res.body.answer}${res.body.handoff_brief ? ` — Handoff: ${res.body.handoff_brief}` : ''}`,
          });
          const text = JSON.stringify(res.body);
          expect(text, 'a phone number or name reached an answer').not.toMatch(/98765|Priya/);
          expect(ms).toBeLessThan(BRAND_ASSISTANT_CEILING_MS);
        };
        const timed = async (send: () => Promise<request.Response>) => {
          const started = Date.now();
          const res = await send();
          return { res, ms: Date.now() - started };
        };

        const brief = await timed(() => as('/api/brand/assistant/brief?refresh=true'));
        record('BRIEF', 'OVERVIEW', '(Overview brief)', brief.res, brief.ms);
        for (const [page, question] of QUESTIONS) {
          const a = await timed(() => post('/api/brand/assistant/ask', { question, page }));
          record('ASK', page, question, a.res, a.ms);
        }
        const customer = s.world.customers.customers.find((c) => c.displayRef.endsWith('e4'))!;
        const conversation = s.world.conversations.conversations.find((c) => c.customerId === customer.customerId)!;
        const summary = await timed(() => as(`/api/brand/conversations/${conversation.conversationId}/summary`));
        record('SUMMARY', 'CONVERSATIONS', '(handoff conversation)', summary.res, summary.ms);
      }
    },
    RUNS * 600_000,
  );
});
