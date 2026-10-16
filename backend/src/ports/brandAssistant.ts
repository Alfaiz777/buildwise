/**
 * The brand agent's own port (L5, "Ask Qwikspot"): where a conversation's AI summary is kept.
 * The model port, shared with the store agent, is ports/assistant.ts.
 */
export interface StoredConversationSummary {
  summary: string;
  handoffBrief: string | null;
  /** The conversation's message count when it was written: a new message makes it stale. */
  messageCount: number;
  generatedAt: string;
  model: string;
}

export interface ConversationSummaryStore {
  get(brandId: string, conversationId: string): Promise<StoredConversationSummary | null>;
  put(brandId: string, conversationId: string, summary: StoredConversationSummary): Promise<void>;
}
