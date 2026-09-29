import type { ToolCall, ToolExecutor, ToolResult } from '../../ports/agent.js';

export type ToolHandler = (input: Record<string, unknown>) => Promise<Omit<ToolResult, 'tool'>>;

/**
 * The backend-owned ToolExecutor. Only registered tools can run; anything else
 * is BLOCKED. Agent tools (docs/05_AI_AGENT_SPEC.md §6) are registered from M5,
 * reservation tools in M5 too. There is deliberately no record_outcome tool.
 */
export class ToolRegistry implements ToolExecutor {
  private readonly handlers = new Map<string, ToolHandler>();

  register(name: string, handler: ToolHandler): this {
    if (this.handlers.has(name)) throw new Error(`Tool already registered: ${name}`);
    this.handlers.set(name, handler);
    return this;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const handler = this.handlers.get(call.tool);
    if (!handler) {
      return { tool: call.tool, status: 'BLOCKED', output: null, resultReference: null, reasonCode: 'UNKNOWN_TOOL' };
    }
    return { tool: call.tool, ...(await handler(call.input)) };
  }
}
