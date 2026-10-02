import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { DEMO_RESET_COLLECTIONS, type DemoDataStore, type DemoHistory } from '../../ports/demoData.js';
import {
  FirestoreCommerceEventRepository,
  FirestoreConversationRepository,
  FirestoreIntentRepository,
  FirestoreRecommendationRepository,
} from './conversationRepositories.js';
import { FirestoreAttributionRefRepository, FirestoreOutcomeRepository } from './outcomeRepository.js';
import { reservationToDoc } from './reservationRepository.js';

const BATCH = 400;

/**
 * Firestore side of Reset demo (Change 14, G4). Deletes only inside brands/{brandId} and
 * the top-level documents whose brand_id is that brand; never another brand.
 */
export class FirestoreDemoDataStore implements DemoDataStore {
  constructor(private readonly db: Firestore) {}

  async wipe(brandId: string): Promise<Record<string, number>> {
    const brand = this.db.collection('brands').doc(brandId);
    const counts: Record<string, number> = {};
    for (const name of DEMO_RESET_COLLECTIONS) {
      const col = brand.collection(name);
      counts[name] = (await col.count().get()).data().count;
      await this.db.recursiveDelete(col); // conversations take their messages with them
    }
    for (const top of ['intentTokens', 'webhookReceipts'] as const) {
      let deleted = 0;
      for (;;) {
        const snap = await this.db.collection(top).where('brand_id', '==', brandId).limit(BATCH).get();
        if (snap.empty) break;
        const batch = this.db.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        deleted += snap.size;
      }
      counts[top] = deleted;
    }
    return counts;
  }

  async setSettings(brandId: string, settings: Record<string, unknown>): Promise<void> {
    await this.db.collection('brands').doc(brandId).update({ settings, updated_at: FieldValue.serverTimestamp() });
  }

  async writeHistory(brandId: string, h: DemoHistory, customerIds: string[]): Promise<Record<string, number>> {
    const brand = this.db.collection('brands').doc(brandId);
    const intents = new FirestoreIntentRepository(this.db);
    const conversations = new FirestoreConversationRepository(this.db);
    const recommendations = new FirestoreRecommendationRepository(this.db);
    const events = new FirestoreCommerceEventRepository(this.db);
    const outcomes = new FirestoreOutcomeRepository(this.db);
    const refs = new FirestoreAttributionRefRepository(this.db);

    for (const i of h.intents) await intents.update(brandId, i.intentId, () => i);
    for (const c of h.conversations) await conversations.create(c);
    for (const r of h.recommendations) await recommendations.create(r);
    for (const e of h.events) await events.record(e);
    for (const r of h.reservations)
      await brand.collection('reservations').doc(r.reservationId).set(reservationToDoc(r));
    for (const o of h.outcomes) await outcomes.createIfAbsent(o);
    for (const r of h.attributionRefs) await refs.create({ ...r, brandId });

    // Flag every synthetic document, so the Outcomes screen can show or exclude it.
    const paths: [string, string[]][] = [
      ['customers', customerIds],
      ['customerIntents', h.intents.map((x) => x.intentId)],
      ['conversations', h.conversations.map((x) => x.conversationId)],
      ['aiRecommendations', h.recommendations.map((x) => x.recommendationId)],
      ['commerceEvents', h.events.map((x) => x.eventId)],
      ['reservations', h.reservations.map((x) => x.reservationId)],
      ['outcomes', h.outcomes.map((x) => x.outcomeId)],
      ['attributionRefs', h.attributionRefs.map((x) => x.refHash)],
    ];
    const counts: Record<string, number> = {};
    for (const [collection, ids] of paths) {
      counts[collection] = ids.length;
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = this.db.batch();
        for (const id of ids.slice(i, i + BATCH))
          batch.update(brand.collection(collection).doc(id), { demo_history: true });
        await batch.commit();
      }
    }
    return counts;
  }
}
