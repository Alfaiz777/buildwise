/**
 * The backend-owned ToolExecutor (docs/05_AI_AGENT_SPEC.md §7). One instance per inbound
 * message. Every call is checked in order — the tool exists, no scope keys, valid input,
 * the action is allowed in this step — then runs with the scope injected by the pipeline,
 * and is recorded (input, output summary, status, reason, duration) for the decision trace.
 */
import { performance } from 'node:perf_hooks';
import { isWriteTool, READ_TOOLS, WRITE_TOOLS, type ToolName } from '../../domain/agentTools.js';
import type { JsonValue, DecisionTrace } from '../../ports/conversationRepositories.js';
import type { ToolCall, ToolExecutor, ToolResult } from '../../ports/agent.js';
import { SCOPE_KEYS, TOOL_INPUTS } from '../../ports/agentTools.js';

export interface ToolScope {
  brandId: string;
  customerId: string;
  conversationId: string;
  intentId: string | null;
  /** The AIRecommendation of this run: create_reservation's idempotency key. */
  recommendationId: string;
}

export type ToolPhase = 'DECIDE' | 'EXECUTE';

export interface ToolOutcome {
  status: 'EXECUTED' | 'FAILED';
  output: unknown;
  reasonCode?: string | null;
}

export type ToolHandler = (input: never, scope: ToolScope) => Promise<ToolOutcome>;
export type ToolHandlers = { [K in ToolName]: (input: never, scope: ToolScope) => Promise<ToolOutcome> };

/** A completed call with its full (in-memory only) output, for the guardrail and the replies. */
export interface ExecutedCall {
  callId: string;
  tool: string;
  phase: ToolPhase;
  input: Record<string, unknown>;
  status: ToolResult['status'];
  reasonCode: string | null;
  output: unknown;
}

type TraceEntry = DecisionTrace['tool_calls'][number];

export class AgentToolExecutor implements ToolExecutor {
  private phase: ToolPhase = 'DECIDE';
  readonly calls: ExecutedCall[] = [];
  readonly trace: TraceEntry[] = [];

  constructor(
    private readonly handlers: ToolHandlers,
    private readonly scope: ToolScope,
    private readonly onBlocked: (tool: string, reason: string) => Promise<void> = async () => {},
  ) {}

  /** Tools a runtime may call while deciding: read tools only (writes run after the guardrail). */
  static readonly DECIDE_TOOLS: readonly ToolName[] = READ_TOOLS;
  static readonly ALL_TOOLS: readonly ToolName[] = [...READ_TOOLS, ...WRITE_TOOLS];

  /** After the AGENT step: the pipeline executes guardrail-approved writes. */
  enterExecutePhase() {
    this.phase = 'EXECUTE';
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const started = performance.now();
    const callId = `tc_${this.calls.length + 1}`;
    const finish = (status: ToolResult['status'], output: unknown, reasonCode: string | null): ToolResult => {
      const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
      this.calls.push({ callId, tool: call.tool, phase: this.phase, input, status, reasonCode, output });
      this.trace.push({
        call_id: callId,
        tool: call.tool,
        kind: isWriteTool(call.tool) ? 'WRITE' : 'READ',
        phase: this.phase,
        input: redact(input),
        output_summary: summarize(call.tool, status, output),
        status,
        reason_code: reasonCode,
        duration_ms: Math.round((performance.now() - started) * 10) / 10,
      });
      return { tool: call.tool, status, output, resultReference: callId, reasonCode };
    };

    // 1. the tool exists
    if (!(call.tool in TOOL_INPUTS)) return finish('BLOCKED', null, 'UNKNOWN_TOOL');
    const tool = call.tool as ToolName;
    // 2. scope comes from the pipeline, never from agent arguments
    const raw = call.input && typeof call.input === 'object' ? call.input : {};
    if (Object.keys(raw).some((k) => SCOPE_KEYS.includes(k))) {
      await this.onBlocked(tool, 'SCOPE_VIOLATION');
      return finish('BLOCKED', null, 'SCOPE_VIOLATION');
    }
    // 3. valid input
    const parsed = TOOL_INPUTS[tool].safeParse(raw);
    if (!parsed.success) return finish('BLOCKED', null, 'INVALID_INPUT');
    // 4. the action is allowed in this step
    if (isWriteTool(tool) && this.phase === 'DECIDE') return finish('BLOCKED', null, 'WRITE_NOT_ALLOWED_IN_DECIDE');
    // 5. run with the injected scope
    try {
      const handler = this.handlers[tool] as (input: unknown, scope: ToolScope) => Promise<ToolOutcome>;
      const outcome = await handler(parsed.data, this.scope);
      return finish(outcome.status, outcome.output, outcome.reasonCode ?? null);
    } catch {
      return finish('FAILED', null, 'TOOL_ERROR');
    }
  }

  /** Full outputs of successful calls of one tool, oldest first. */
  outputsOf<T>(tool: ToolName): { callId: string; input: Record<string, unknown>; output: T }[] {
    return this.calls
      .filter((c) => c.tool === tool && c.status === 'EXECUTED')
      .map((c) => ({ callId: c.callId, input: c.input, output: c.output as T }));
  }
}

const round2 = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

/** Trace input: coordinates at ~1 km, free text truncated. */
function redact(input: Record<string, unknown>): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'latitude' || key === 'longitude') out[key] = round2(value) as number;
    else if (typeof value === 'string') out[key] = value.length > 60 ? `${value.slice(0, 57)}…` : value;
    else out[key] = JSON.parse(JSON.stringify(value ?? null));
  }
  return out;
}

function summarize(tool: string, status: string, output: unknown): { [key: string]: JsonValue } {
  if (!output || typeof output !== 'object') return { status };
  const o = output as Record<string, unknown>;
  switch (tool) {
    case 'find_nearby_stores': {
      const origin = o.origin as { source: string; approximate: boolean; locality: string | null } | null;
      return {
        status: String(o.status),
        origin: origin ? `${origin.source}${origin.approximate ? ' (approximate)' : ''}` : null,
        locality: origin?.locality ?? null,
        eligible: Array.isArray(o.eligible) ? o.eligible.length : 0,
        excluded: Array.isArray(o.excluded) ? o.excluded.length : 0,
      };
    }
    case 'get_product_context':
      return {
        status: String(o.status),
        product: (o.product as { title?: string } | null)?.title ?? null,
        alternatives: Array.isArray(o.alternatives) ? o.alternatives.length : 0,
      };
    case 'create_reservation':
    case 'cancel_reservation': {
      const r = o.reservation as { reservation_id: string; status: string } | null;
      return {
        status: String(o.status),
        reason: (o.reason as string) ?? null,
        reservation_id: r?.reservation_id ?? null,
      };
    }
    case 'check_store_inventory':
      return { status: String(o.status), available_quantity: Number(o.available_quantity ?? 0) };
    case 'get_store_hours':
      return { status: String(o.status), open_now: o.open_now === true, open_until: (o.open_until as string) ?? null };
    case 'get_customer_history':
      return { active_reservations: Array.isArray(o.active_reservations) ? o.active_reservations.length : 0 };
    default:
      return { status };
  }
}
