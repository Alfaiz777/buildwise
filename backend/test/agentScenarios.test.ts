/**
 * The runtime-agnostic AI scenario suite on MockAgentRuntime (docs/08 §7.3: 1 run, 1/1).
 * In L1 the same suite runs on AdkGeminiAgentRuntime with runs = 5 — no other change.
 * MockAgentRuntime results verify pipeline, tools and guardrail only, never AI quality.
 */
import { MockAgentRuntime } from '../src/adapters/agent/mockAgentRuntime.js';
import { describe, expect, it } from 'vitest';
import { requiredPasses, runAgentScenarioSuite } from './contracts/agentScenarioSuite.js';

runAgentScenarioSuite({
  name: 'MockAgentRuntime',
  runtime: 'MOCK',
  makeRuntime: () => new MockAgentRuntime(),
  runs: 1,
});

describe('docs/08 §7.3 pass rules', () => {
  it('MOCK 1/1; ADK_GEMINI 5 runs: 8–12 need 5/5, 1–7 need 4/5', () => {
    expect(requiredPasses('MOCK', 3, 1)).toBe(1);
    expect(requiredPasses('ADK_GEMINI', 3, 5)).toBe(4);
    expect(requiredPasses('ADK_GEMINI', 8, 5)).toBe(5);
    expect(requiredPasses('ADK_GEMINI', 12, 5)).toBe(5);
  });
});
