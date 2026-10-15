/**
 * Plays the conversation test set (conversations.fixtures.ts) through the real pipeline and
 * checks every step: the action, no commerce facts in a conversational reply, no buttons on a
 * closing, the customer's language, the length limits, the handoff button, no stray hold.
 */
import { performance } from 'node:perf_hooks';
import { checkConversationalText, detectLanguage } from '../../src/domain/conversationalReplies.js';
import { OPTION } from '../../src/domain/agentReplies.js';
import type { Logger } from '../../src/lib/logger.js';
import type { AgentRuntime } from '../../src/ports/agent.js';
import { ahmedabadWorld, type SimulatorResponse } from '../ahmedabadWorld.js';
import type { ConversationCase, Step } from './conversations.fixtures.js';

export interface StepResult {
  caseId: string;
  step: number;
  message: string;
  action: string;
  /** Who answered: RULES_TAP, GEMINI, MOCK, BACKUP, FALLBACK (from the reply-timing log line). */
  path: string;
  reply: string;
  options: string[];
  /** Wall time of the request, ms. */
  ms: number;
  failures: string[];
}

export async function runConversation(
  c: ConversationCase,
  runtimes: { agent?: AgentRuntime; backupAgent?: AgentRuntime; aiBudgetMs?: number } = {},
): Promise<StepResult[]> {
  const timings: Record<string, unknown>[] = [];
  const logger: Logger = {
    debug() {},
    warn() {},
    error() {},
    info(message, fields) {
      if (message === 'conversation.reply_timing' && fields) timings.push(fields);
    },
  };
  const s = await ahmedabadWorld({ ...runtimes, logger });
  const storeNames = s.world.stores.stores
    .filter((x) => x.brandId === 'brand_A')
    .flatMap((x) => [x.storeName, ...(x.shortName ? [x.shortName] : [])]);
  const ref = `conv_${c.id}`;
  const results: StepResult[] = [];
  for (const [i, step] of c.steps.entries()) {
    const holdsBefore = s.world.reservations.reservations.length;
    const started = performance.now();
    const res = 'say' in step ? await s.say(ref, step.say) : await s.tap(ref, step.tap);
    const ms = Math.round(performance.now() - started);
    const message = 'say' in step ? step.say : `[tap ${step.tap}]`;
    results.push({
      caseId: c.id,
      step: i + 1,
      message,
      ...observe(res),
      path: String(timings.at(-1)?.path ?? '?'),
      ms,
      failures: check(step, res, {
        storeNames,
        customerText: 'say' in step ? step.say : null,
        newHolds: s.world.reservations.reservations.length - holdsBefore,
      }),
    });
  }
  return results;
}

function observe(res: SimulatorResponse) {
  const out = res.body.outbound_messages?.[0];
  return {
    action: String(res.body.decision?.action ?? `HTTP ${res.status}`),
    reply: String(out?.text ?? ''),
    options: ((out?.options ?? []) as { option_id: string }[]).map((o) => o.option_id),
  };
}

function check(
  step: Step,
  res: SimulatorResponse,
  ctx: { storeNames: string[]; customerText: string | null; newHolds: number },
): string[] {
  const failures: string[] = [];
  const { action, reply, options } = observe(res);
  const e = step.expect;
  if (res.status !== 200) return [`HTTP ${res.status}`];
  if (!e.actions.includes(action as never)) failures.push(`action ${action}, expected ${e.actions.join('|')}`);
  if (e.noHold && ctx.newHolds > 0) failures.push('a hold was created');
  if (e.includes && !e.includes.test(reply)) failures.push(`reply lacks ${e.includes}`);
  if (e.handoffButton && !options.includes(OPTION.handoff)) failures.push('no "Talk to a person" button');
  // A cancellation is NO_ACTION too, but its reply is built from the verified tool result.
  const executed = (res.body.decision?.executed_action as { type?: string } | null)?.type;
  if (action === 'NO_ACTION' && (!executed || executed === 'NONE')) {
    // Any free NO_ACTION text: no price, stock, store, distance, delivery time or promise.
    const content = checkConversationalText(reply, { storeNames: ctx.storeNames, limits: false });
    if (content) failures.push(`forbidden content: ${content}`);
  }
  if (e.turn) {
    const limits = checkConversationalText(reply, { storeNames: ctx.storeNames, customerText: ctx.customerText });
    if (limits) failures.push(`conversational rule: ${limits}`);
    if (e.turn === 'CLOSING' && options.length > 0) failures.push(`buttons on a closing: ${options.join(',')}`);
    if (e.language && detectLanguage(reply) !== e.language)
      failures.push(`language ${detectLanguage(reply)}, expected ${e.language}`);
  }
  return failures;
}

export const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};
