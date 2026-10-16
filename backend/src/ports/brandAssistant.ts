/**
 * The brand agent's ports (L5, "Ask Qwikspot"): the model that writes an answer from a data pack,
 * and where a conversation's AI summary is kept. Read-only over the brand's data.
 */
import type { BrandAnswer, ConsolePage } from '../domain/brandAssistant.js';

export type BrandTask = 'ANSWER' | 'BRIEF' | 'SUMMARY';

export interface BrandModelInput {
  task: BrandTask;
  page: ConsolePage;
  question?: string;
  /** The brand pack or one conversation pack: computed data only, no shopper identity. */
  data: unknown;
}

/** Read tools the model may call (at most 2 rounds); each returns verified, PII-free data. */
export interface BrandModelTools {
  get_store(input: { store_id: string }): Promise<unknown>;
  list_conversations(input: {
    without_hold?: boolean;
    refused_by_store?: boolean;
    with_person?: boolean;
    limit?: number;
  }): Promise<unknown>;
}

export interface BrandModelResult {
  answer: BrandAnswer;
  /** What the tools returned this run: numbers in the answer may come from these too. */
  toolOutputs: unknown[];
  toolCalls: string[];
}

export interface BrandAssistantModel {
  readonly model: string;
  generate(input: BrandModelInput, tools: BrandModelTools, signal: AbortSignal): Promise<BrandModelResult>;
}

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
