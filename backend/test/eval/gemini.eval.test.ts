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
 * Prints one table: action, reply and pass / fail per scenario. Assertions are on structured
 * output (action, guardrail, offered stores, persisted records), never on wording.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { AdkGeminiAgentRuntime } from '../../src/adapters/agent/adkGeminiAgentRuntime.js';
import { VertexGeminiClient } from '../../src/adapters/agent/geminiClient.js';
import { DEFAULT_VERTEX_LOCATION, DEFAULT_VERTEX_MODEL } from '../../src/config/env.js';
import type { Logger } from '../../src/lib/logger.js';
import { globalNever, requiredPasses, SCENARIOS } from '../contracts/agentScenarioSuite.js';
import { buildScenarioWorld, ORIGIN, type ScenarioWorld } from '../scenarioWorld.js';

const ENABLED = process.env.RUN_GEMINI_EVAL === '1';
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
const MODEL = process.env.VERTEX_MODEL || DEFAULT_VERTEX_MODEL;
const LOCATION = process.env.VERTEX_LOCATION || DEFAULT_VERTEX_LOCATION;

interface Row {
  id: string;
  scenario: string;
  result: string;
  detail: string;
  reply: string;
}
const rows: Row[] = [];
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
      `Decisions: ${latencies.length}; latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${sorted.at(-1) ?? 0} ms; tokens in ${tokens.prompt}, out ${tokens.output}`,
      '',
      '| # | Scenario | Result | Action / detail | Reply (last message) |',
      '|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.id} | ${r.scenario} | ${r.result} | ${r.detail} | ${short(r.reply)} |`),
      '',
    ];
    console.log(lines.join('\n'));
  });

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
          for (let run = 0; run < RUNS; run++) {
            const { s, obs } = await scenario.run(makeRuntime);
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
      // Handoff is off here so that one slow turn (→ fallback) does not hand the whole conversation
      // to a person and hide the turns after it; a fallback still fails the test below.
      const s = await buildScenarioWorld({ agent: makeRuntime(), handoffEnabled: false });
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
            hinglish.body.decision?.decision_source === 'AGENT',
          String(hinglish.body.decision?.decision_source),
        ),
      );

      expect(globalNever(s, 'ADK_GEMINI')).toEqual([]);
      expect(
        s.world.recommendations.recommendations.filter((r) => r.decisionSource !== 'AGENT').length,
        'a turn fell back to the deterministic reply (timeout, error or invalid output)',
      ).toBe(0);
      expect(results.filter((ok) => !ok).length, 'failed WhatsApp steps (see the table)').toBe(0);
    }, 600_000);
  });
});
