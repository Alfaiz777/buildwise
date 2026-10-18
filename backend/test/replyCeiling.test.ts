/**
 * L5: no typed message waits more than ~12 s. Gemini gets at most 9 s (7 s per request, a retry
 * only if the deadline still leaves time for one); the backup has the last 2 s. Fake timers: the
 * model "takes" seconds without the test waiting for them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdkGeminiAgentRuntime,
  GEMINI_DEADLINE_MS,
  GEMINI_MIN_ATTEMPT_MS,
  GEMINI_REQUEST_TIMEOUT_MS,
} from '../src/adapters/agent/adkGeminiAgentRuntime.js';
import type { GeminiClient, GeminiRequest } from '../src/adapters/agent/geminiClient.js';
import { MockAgentRuntime } from '../src/adapters/agent/mockAgentRuntime.js';
import { AI_BACKUP_BUDGET_MS, AI_DECISION_BUDGET_MS } from '../src/application/conversation/agentStage.js';
import { ahmedabadWorld, type SimulatorResponse } from './ahmedabadWorld.js';

/** A Gemini that answers after `delayMs` (or when cancelled), counting its requests. */
function delayedGemini(delayMs: number, replyText = 'Hi! 😊 How can I help you today?') {
  const requests: GeminiRequest[] = [];
  const client: GeminiClient = {
    generate: (request, signal) => {
      requests.push(request);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve({
              functionCalls: [],
              text: JSON.stringify({
                intent_type: 'UNKNOWN',
                confidence: 0.8,
                action: 'NO_ACTION',
                reason: 'Greeting.',
                reply_text: replyText,
                turn_type: 'GREETING',
              }),
              raw: { role: 'model', parts: [] },
              usage: { promptTokens: 1, outputTokens: 1 },
            }),
          delayMs,
        );
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    },
  };
  return { client, requests };
}

/** Sends a message and advances the fake clock until the reply arrives; returns it and the time it took. */
async function timed(send: () => Promise<SimulatorResponse>): Promise<{ res: SimulatorResponse; ms: number }> {
  let done: SimulatorResponse | null = null;
  const pending = Promise.resolve(send()).then((r) => (done = r));
  let ms = 0;
  while (!done && ms < 60_000) {
    await vi.advanceTimersByTimeAsync(50);
    ms += 50;
  }
  return { res: await pending, ms };
}

describe('the 25 s reply ceiling (Gemini-first)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the limits: Gemini 22 s (10 s per request), backup 2 s, ceiling 25 s', () => {
    expect(GEMINI_DEADLINE_MS).toBe(22_000);
    expect(GEMINI_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(AI_BACKUP_BUDGET_MS).toBe(2_000);
    expect(AI_DECISION_BUDGET_MS).toBe(25_000);
    expect(GEMINI_DEADLINE_MS + AI_BACKUP_BUDGET_MS).toBeLessThanOrEqual(AI_DECISION_BUDGET_MS);
    // A request that stalls to its 10 s cut-off still leaves time for one real retry.
    expect(GEMINI_REQUEST_TIMEOUT_MS + GEMINI_MIN_ATTEMPT_MS).toBeLessThan(GEMINI_DEADLINE_MS);
  });

  it('Gemini stalls for 30 s → the backup answers, and the reply arrives in under 25 s', async () => {
    const gemini = delayedGemini(30_000);
    const s = await ahmedabadWorld({
      agent: new AdkGeminiAgentRuntime({ client: gemini.client, model: 'gemini-test' }),
      backupAgent: new MockAgentRuntime(),
    });
    const { res, ms } = await timed(() => s.say('c1', 'I need Vitamin C Glow Serum 30 ml today near Satellite'));
    expect(res.body.decision).toMatchObject({ decision_source: 'AGENT_BACKUP', action: 'STORE_DISCOVERY' });
    expect(res.body.outbound_messages[0].text).toContain('In stock at 3 stores in Satellite');
    expect(ms).toBeGreaterThanOrEqual(GEMINI_DEADLINE_MS);
    expect(ms).toBeLessThan(25_000);
    // Unanswered at 4.5 s, the request was sent once more (hedged) and the pair was given the
    // whole 22 s deadline; both stalled, so only then did the backup answer inside the 25 s ceiling.
    expect(gemini.requests).toHaveLength(2);
  });

  it('Gemini answers at 6 s → Gemini’s reply is used', async () => {
    const gemini = delayedGemini(6_000, 'Hello there! 😊 What can I find for you?');
    const s = await ahmedabadWorld({
      agent: new AdkGeminiAgentRuntime({ client: gemini.client, model: 'gemini-test' }),
      backupAgent: new MockAgentRuntime(),
    });
    const { res, ms } = await timed(() => s.say('c1', 'hello'));
    expect(res.body.decision).toMatchObject({ decision_source: 'AGENT', runtime: 'ADK_GEMINI' });
    expect(res.body.outbound_messages[0].text).toBe('Hello there! 😊 What can I find for you?');
    expect(ms).toBeGreaterThanOrEqual(6_000);
    expect(ms).toBeLessThan(7_000);
  });

  it('a request that fails fast is retried while the deadline still allows a real attempt', async () => {
    let calls = 0;
    const flaky = delayedGemini(1_000);
    const client: GeminiClient = {
      generate: (request, signal) =>
        ++calls === 1
          ? Promise.reject(Object.assign(new Error('busy'), { status: 429 }))
          : flaky.client.generate(request, signal),
    };
    const s = await ahmedabadWorld({
      agent: new AdkGeminiAgentRuntime({ client, model: 'gemini-test' }),
      backupAgent: new MockAgentRuntime(),
    });
    const { res } = await timed(() => s.say('c1', 'hello'));
    expect(calls).toBe(2);
    expect(res.body.decision).toMatchObject({ decision_source: 'AGENT' });
  });

  it('a late start (a slow context build) shortens Gemini’s turn, never the backup’s: still under 25 s', async () => {
    const gemini = delayedGemini(30_000);
    const s = await ahmedabadWorld({
      agent: new AdkGeminiAgentRuntime({ client: gemini.client, model: 'gemini-test' }),
      backupAgent: new MockAgentRuntime(),
    });
    // The context build's store read takes 4 s (the first read of the turn); later reads are fast.
    const list = s.world.stores.list.bind(s.world.stores);
    let reads = 0;
    s.world.stores.list = async (brandId: string) => {
      if (reads++ === 0) await new Promise((r) => setTimeout(r, 4_000));
      return list(brandId);
    };
    const { res, ms } = await timed(() => s.say('c1', 'hello'));
    expect(res.body.decision).toMatchObject({ decision_source: 'AGENT_BACKUP' });
    // Gemini got 25 − 2 − 4 = 19 s instead of 22 s; the backup still had its 2 s.
    expect(ms).toBeGreaterThanOrEqual(23_000 - 100);
    expect(ms).toBeLessThan(25_000);
    expect(res.body.outbound_messages[0].text.length).toBeGreaterThan(0);
  });
});
