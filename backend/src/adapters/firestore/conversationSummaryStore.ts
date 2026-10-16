import type { Firestore } from 'firebase-admin/firestore';
import type { ConversationSummaryStore, StoredConversationSummary } from '../../ports/brandAssistant.js';

/**
 * L5: a conversation's AI summary, kept as `ai_summary` on the conversation document itself
 * (Reset demo wipes conversations, so it clears these too). Server-only like every document.
 */
export class FirestoreConversationSummaryStore implements ConversationSummaryStore {
  constructor(private readonly db: Firestore) {}

  private ref(brandId: string, conversationId: string) {
    return this.db.collection('brands').doc(brandId).collection('conversations').doc(conversationId);
  }

  async get(brandId: string, conversationId: string): Promise<StoredConversationSummary | null> {
    const raw = (await this.ref(brandId, conversationId).get()).get('ai_summary') as
      Record<string, unknown> | undefined;
    if (!raw || typeof raw.summary !== 'string') return null;
    return {
      summary: raw.summary,
      handoffBrief: typeof raw.handoff_brief === 'string' ? raw.handoff_brief : null,
      messageCount: Number(raw.message_count ?? -1),
      generatedAt: String(raw.generated_at ?? ''),
      model: String(raw.model ?? ''),
    };
  }

  async put(brandId: string, conversationId: string, s: StoredConversationSummary): Promise<void> {
    await this.ref(brandId, conversationId).update({
      ai_summary: {
        summary: s.summary,
        handoff_brief: s.handoffBrief,
        message_count: s.messageCount,
        generated_at: s.generatedAt,
        model: s.model,
      },
    });
  }
}
