/**
 * L5: the conversation test set (test/eval/conversations.fixtures.ts) against the rules runtime
 * (the mock — what answers when Gemini is not configured, and the backup behind it). The same
 * set runs against real Gemini in the live eval.
 */
import { describe, expect, it } from 'vitest';
import { checkedMessages, CONVERSATIONS } from './eval/conversations.fixtures.js';
import { runConversation } from './eval/conversationRunner.js';

describe('conversation test set — rules runtime (mock)', () => {
  it('has at least 40 checked shopper messages', () => {
    expect(checkedMessages()).toBeGreaterThanOrEqual(40);
  });

  for (const c of CONVERSATIONS) {
    it(`${c.id} · ${c.title}`, async () => {
      const results = await runConversation(c);
      const failed = results
        .filter((r) => r.failures.length > 0)
        .map((r) => `${r.step}. "${r.message}" → ${r.action}: ${r.failures.join('; ')} — reply: ${r.reply}`);
      expect(failed).toEqual([]);
    });
  }
});
