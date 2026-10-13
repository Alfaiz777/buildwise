/**
 * LIVE evaluation of AdkGeminiAgentRuntime (docs/05 §16, docs/08 §7): the 12 scenarios of the
 * runtime-agnostic suite plus the WhatsApp conversation from the 12 Oct 2026 test, against
 * real Gemini on Vertex AI. Everything else is the in-memory test world (the docs/08 §7.1
 * fixture), so nothing is written to any project: the only outside call is to Vertex AI.
 *
 * Opt-in — skipped unless RUN_GEMINI_EVAL=1 (it needs credentials and costs tokens):
 *   gcloud auth application-default login
 *   RUN_GEMINI_EVAL=1 VERTEX_PROJECT=<project> npm run eval:gemini --workspace backend
 * Optional: EVAL_RUNS (default 1; the final evaluation uses 5), VERTEX_MODEL, VERTEX_LOCATION.
 *
 * Prints one table — who decided, action, reply and pass / fail per scenario — and writes it to
 * GEMINI_EVAL_REPORT (default: <tmp>/qwikspot-gemini-eval.md). Assertions are on structured
 * output (action, guardrail, offered stores, persisted records), never on wording.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AdkGeminiAgentRuntime } from '../../src/adapters/agent/adkGeminiAgentRuntime.js';
import { VertexGeminiClient } from '../../src/adapters/agent/geminiClient.js';
import { MockAgentRuntime } from '../../src/adapters/agent/mockAgentRuntime.js';
import { DEFAULT_VERTEX_LOCATION, DEFAULT_VERTEX_MODEL } from '../../src/config/env.js';
import type { Logger } from '../../src/lib/logger.js';
import { globalNever, requiredPasses, SCENARIOS, setScenarioWorldDefaults } from '../contracts/agentScenarioSuite.js';
import { buildScenarioWorld, ORIGIN, type ScenarioWorld } from '../scenarioWorld.js';

const ENABLED = process.env.RUN_GEMINI_EVAL === '1';
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
const MODEL = process.env.VERTEX_MODEL || DEFAULT_VERTEX_MODEL;
const LOCATION = process.env.VERTEX_LOCATION || DEFAULT_VERTEX_LOCATION;
/** Where the result table is also written, as Markdown (the runner hides console output of a passing file). */
const REPORT = process.env.GEMINI_EVAL_REPORT || join(tmpdir(), 'qwikspot-gemini-eval.md');

interface Row {
  id: string;
  scenario: string;
  result: string;
  /** Who decided the turns: Gemini (G), the mock backup (B), the fixed fallback (F). */
  decided: string;
  detail: string;
  reply: string;
}
const rows: Row[] = [];
const totals = { gemini: 0, backup: 0, fallback: 0 };
/** Who decided, from recommendation index `from` on. */
function decidedBy(s: ScenarioWorld, from = 0): string {
  const recs = s.world.recommendations.recommendations.slice(from);
  const gemini = recs.filter((r) => r.decisionSource === 'AGENT').length;
  const backup = recs.filter((r) => r.decisionSource === 'AGENT_BACKUP').length;
  const fallback = recs.length - gemini - backup;
  totals.gemini += gemini;
  totals.backup += backup;
  totals.fallback += fallback;
  return [gemini ? `${gemini}G` : '', backup ? `${backup}B` : '', fallback ? `${fallback}F` : '']
    .filter(Boolean)
    .join(' ');
}
const latencies: number[] = [];
const tokens = { prompt: 0, output: 0 };

const logger: Logger = {
  debug() {},
  warn() {},
  error() {},
  info(message, fields) {
    if (message !== 'agent.gemini_decision' || !fields) return;
    latencies.push(Number(fields.latency_ms));
    tokens.prompt += Number(fields.prompt_tokens);
    tokens.output += Number(fields.output_tokens);
  },
};

let client: VertexGeminiClient | null = null;
const makeRuntime = () => {
  client ??= new VertexGeminiClient({ project: PROJECT, location: LOCATION });
  return new AdkGeminiAgentRuntime({ client, model: MODEL, logger });
};

const oneLine = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
const short = (text: string, max = 150) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const lastReply = (s: ScenarioWorld) =>
  oneLine(s.world.conversations.messages.filter((m) => m.direction === 'OUTBOUND').at(-1)?.text ?? '');

describe.skipIf(!ENABLED)(`LIVE Gemini evaluation — ${MODEL} @ ${LOCATION} (${RUNS} run(s) per scenario)`, () => {
  afterAll(() => {
    const sorted = [...latencies].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    const lines = [
      '',
      `Gemini live eval — model ${MODEL}, location ${LOCATION}, ${RUNS} run(s) per scenario`,
      `Turns decided by Gemini (G): ${totals.gemini}; by the mock backup after a Gemini failure (B): ${totals.backup}; fixed fallback (F): ${totals.fallback}`,
      `Gemini attempts: ${latencies.length}; latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${sorted.at(-1) ?? 0} ms; tokens in ${tokens.prompt}, out ${tokens.output}`,
      '',
      '| # | Scenario | Result | Decided by | Action / detail | Reply (last message) |',
      '|---|---|---|---|---|---|',
      ...rows.map(
        (r) => `| ${r.id} | ${r.scenario} | ${r.result} | ${r.decided} | ${r.detail} | ${short(r.reply, 110)} |`,
      ),
      '',
    ];
    console.log(lines.join('\n'));
    writeFileSync(REPORT, lines.join('\n'));
  });

  // As in production (composition/container.ts): the deterministic mock stands behind Gemini.
  setScenarioWorldDefaults({ backupAgent: new MockAgentRuntime() });

  it('is configured: a real project (VERTEX_PROJECT) and Application Default Credentials', () => {
    expect(PROJECT, 'set VERTEX_PROJECT to the Google Cloud project that has Vertex AI enabled').not.toBe('');
    expect(PROJECT.startsWith('demo-')).toBe(false);
  });

  describe('docs/08 §7.2 — the 12 scenarios', () => {
    for (const scenario of SCENARIOS) {
      it(
        `${scenario.n} · ${scenario.title}`,
        async () => {
          let passes = 0;
          const details: string[] = [];
          const never: string[] = [];
          let reply = '';
          const decided: string[] = [];
          for (let run = 0; run < RUNS; run++) {
            const { s, obs } = await scenario.run(makeRuntime);
            decided.push(decidedBy(s));
            never.push(...(obs.never ?? []), ...globalNever(s, 'ADK_GEMINI'));
            if (obs.ok) passes++;
            details.push(obs.detail);
            reply = lastReply(s);
          }
          const required = requiredPasses('ADK_GEMINI', scenario.n, RUNS);
          const ok = never.length === 0 && passes >= required;
          rows.push({
            id: String(scenario.n),
            scenario: oneLine(scenario.title),
            result: `${ok ? 'PASS' : 'FAIL'} ${passes}/${RUNS}`,
            decided: decided.join(' · '),
            detail: oneLine([...new Set(details)].join(' ; ') + (never.length ? ` NEVER: ${never.join(', ')}` : '')),
            reply,
          });
          expect(never, '"never" condition violated').toEqual([]);
          expect(passes, `passed ${passes}/${RUNS}, need ${required}: ${details.join('; ')}`).toBeGreaterThanOrEqual(
            required,
          );
        },
        RUNS * 120_000,
      );
    }
  });

  describe('WhatsApp, 12 Oct 2026 — a customer who writes in directly (no storefront intent)', () => {
    const MINERAL_50 = 'var_2011';
    const GEL_50 = 'var_2013';
    /** The scenario world plus a Bandra store that stocks both sunscreens. */
    async function bandraWorld() {
      const s = await buildScenarioWorld({ agent: makeRuntime(), backupAgent: new MockAgentRuntime() });
      await s.world.stores.upsertFromImport('brand_A', [
        {
          storeId: 'sc_BND',
          storeName: 'Bandra Store',
          city: 'Mumbai',
          address: 'Linking Road, Bandra, Mumbai 400050',
          latitude: ORIGIN.latitude + 0.06,
          longitude: ORIGIN.longitude + 0.03,
          storeHours: Object.fromEntries([
            ['timezone', 'Asia/Kolkata'],
            ...['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [
              d,
              '10:00-21:00',
            ]),
          ]),
          storeStatus: 'ACTIVE' as const,
          reservationAvailable: true,
          pickupAvailable: true,
        },
      ]);
      const variants = await s.world.products.listVariants('brand_A');
      await s.world.inventory.upsertStock(
        'brand_A',
        [MINERAL_50, GEL_50].map((variantId) => {
          const v = variants.find((x) => x.variantId === variantId)!;
          return {
            storeId: 'sc_BND',
            sku: v.sku,
            canonicalSku: v.canonicalSku!,
            variantId,
            quantity: 4,
            offlinePrice: v.price,
          };
        }),
        () => 'IN_STOCK',
      );
      for (const row of s.world.inventory.rows) row.availabilityStatus = row.quantity > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';
      return s;
    }

    type Res = Awaited<ReturnType<ScenarioWorld['say']>>;
    const action = (res: Res) => String(res.body.decision?.action);
    const text = (res: Res) => oneLine(res.body.outbound_messages?.[0]?.text);
    const holds = (res: Res) =>
      ((res.body.outbound_messages?.[0]?.options ?? []) as { option_id: string }[])
        .map((o) => o.option_id)
        .filter((id) => id.startsWith('hold:'));

    it('the whole conversation, in order, keeps the product across turns', async () => {
      const s = await bandraWorld();
      const step = (id: string, scenario: string, res: Res, ok: boolean, detail = '') => {
        rows.push({
          id,
          scenario,
          result: ok ? 'PASS' : 'FAIL',
          decided: decidedBy(s, s.world.recommendations.recommendations.length - 1),
          detail: oneLine(`${action(res)}${detail ? ` ${detail}` : ''}`),
          reply: text(res),
        });
        return ok;
      };
      const results: boolean[] = [];

      const hi = await s.say('w1', 'Hi');
      results.push(
        step(
          'W1',
          '"Hi" → a welcome that names the brand',
          hi,
          action(hi) === 'NO_ACTION' && /Brand brand_A/.test(text(hi)),
        ),
      );

      const generic = await s.say('w1', 'Is the sunscreen available near Bandra today?');
      results.push(
        step(
          'W2',
          '"Is the sunscreen available near Bandra today?" → asks which sunscreen, lists both',
          generic,
          /Mineral/i.test(text(generic)) && /Gel/i.test(text(generic)) && holds(generic).length === 0,
        ),
      );

      const named = await s.say('w1', 'Mineral Sunscreen SPF 50, 50 g');
      results.push(
        step(
          'W3',
          '"Mineral Sunscreen SPF 50, 50 g" → the Bandra store card (area kept from before)',
          named,
          action(named) === 'STORE_DISCOVERY' && holds(named).includes('hold:sc_BND'),
          holds(named).join(','),
        ),
      );

      const hold = await s.tap('w1', 'hold:sc_BND');
      const reserved = s.world.reservations.reservations.filter((r) => r.variantId === MINERAL_50).length;
      results.push(
        step(
          'W4',
          'taps "Pick up today" → the hold is placed',
          hold,
          action(hold) === 'STORE_RESERVATION' && reserved === 1,
          `${reserved} hold(s)`,
        ),
      );

      const skin = await s.say('w1', 'Is it good for oily skin?');
      results.push(
        step(
          'W5',
          '"Is it good for oily skin?" → answers about Mineral Sunscreen from verified data',
          skin,
          action(skin) === 'EDUCATE' && /Mineral/i.test(text(skin)),
        ),
      );

      const better = await s.say('w1', 'Which is better, Mineral or Gel sunscreen?');
      results.push(
        step(
          'W6',
          '"Which is better, Mineral or Gel sunscreen?" → compares the two',
          better,
          action(better) === 'COMPARE' && /Mineral/i.test(text(better)) && /Gel/i.test(text(better)),
        ),
      );

      const hinglish = await s.say('w1', 'kal tak Bandra mein milega?');
      results.push(
        step(
          'W7',
          'Hinglish "kal tak Bandra mein milega?" → understood: store search or online',
          hinglish,
          ['STORE_DISCOVERY', 'ONLINE_PURCHASE', 'EDUCATE', 'NO_ACTION'].includes(action(hinglish)) &&
            hinglish.body.decision?.decision_source !== 'DETERMINISTIC_FALLBACK',
          String(hinglish.body.decision?.decision_source),
        ),
      );

      expect(globalNever(s, 'ADK_GEMINI')).toEqual([]);
      // A slow Gemini turn is answered by the mock backup; only the fixed fallback is a failure here.
      expect(
        s.world.recommendations.recommendations.filter((r) => r.decisionSource === 'DETERMINISTIC_FALLBACK').length,
        'a turn ended in the fixed fallback reply (Gemini and the backup both failed)',
      ).toBe(0);
      expect(results.filter((ok) => !ok).length, 'failed WhatsApp steps (see the table)').toBe(0);
    }, 600_000);
  });
});
