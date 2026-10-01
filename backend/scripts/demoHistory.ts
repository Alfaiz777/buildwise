/**
 * Writes the synthetic demo history (application/demoHistory.ts) into the EMULATOR through
 * the live Firestore repositories, then marks every written document `demo_history: true`
 * (docs/00 §11.8 Change 13, F9). Local profile / seed only — never wired into the app.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  FirestoreCommerceEventRepository,
  FirestoreConversationRepository,
  FirestoreCustomerRepository,
  FirestoreIntentRepository,
  FirestoreRecommendationRepository,
} from '../src/adapters/firestore/conversationRepositories.js';
import {
  FirestoreAttributionRefRepository,
  FirestoreOutcomeRepository,
} from '../src/adapters/firestore/outcomeRepository.js';
import { reservationToDoc } from '../src/adapters/firestore/reservationRepository.js';
import {
  generateDemoHistory,
  type DemoHistory,
  type HistoryStore,
  type HistoryVariant,
} from '../src/application/demoHistory.js';
import type { StoreHours } from '../src/domain/storeHours.js';

export const DEMO_HISTORY_SEED = 20261001;

export async function writeDemoHistory(
  db: Firestore,
  input: { brandId: string; now: Date; days?: number; seed?: number },
): Promise<{ counts: Record<string, number> }> {
  const brand = db.collection('brands').doc(input.brandId);
  const [storesSnap, variantsSnap, productsSnap] = await Promise.all([
    brand.collection('stores').get(),
    brand.collection('productVariants').get(),
    brand.collection('products').get(),
  ]);
  const titles = new Map(productsSnap.docs.map((d) => [d.id, String(d.get('title'))]));
  const stores: HistoryStore[] = storesSnap.docs
    .filter((d) => d.get('city') === 'Mumbai' && typeof d.get('latitude') === 'number')
    .map((d) => ({
      storeId: d.id,
      storeName: d.get('store_name'),
      city: d.get('city'),
      address: d.get('address') ?? null,
      retailerId: d.get('retailer_id') ?? null,
      latitude: d.get('latitude'),
      longitude: d.get('longitude'),
      storeHours: d.get('store_hours') as StoreHours,
    }));
  const variant = (sku: string): HistoryVariant => {
    const d = variantsSnap.docs.find((x) => x.get('sku') === sku);
    if (!d) throw new Error(`demo history: variant ${sku} not synced`);
    return {
      variantId: d.id,
      productId: d.get('product_id'),
      productTitle: titles.get(d.get('product_id')) ?? sku,
      title: d.get('title'),
      sku,
      canonicalSku: d.get('canonical_sku'),
      price: d.get('price'),
      currency: d.get('currency'),
    };
  };

  const plan = generateDemoHistory({
    seed: input.seed ?? DEMO_HISTORY_SEED,
    now: input.now,
    brandId: input.brandId,
    days: input.days ?? 28,
    stores,
    serum30: variant('DBC-VCSERUM-30'),
    serum50: variant('DBC-VCSERUM-50'),
  });

  // Synthetic customers through the live identity path; their IDs replace the hist:<ref> placeholders.
  const customers = new FirestoreCustomerRepository(db);
  let json = JSON.stringify(plan);
  const customerIds: string[] = [];
  for (const ref of plan.customerRefs) {
    const { customer } = await customers.findOrCreateByIdentity(
      input.brandId,
      { channel: 'SIMULATOR', externalRef: `sim:${ref}` },
      { consentState: 'NOT_OPTED_IN', shopifyCustomerId: null, displayRef: `sim:${ref}` },
      input.now.toISOString(),
    );
    customerIds.push(customer.customerId);
    json = json.split(`"hist:${ref}"`).join(`"${customer.customerId}"`);
  }
  const h = JSON.parse(json) as DemoHistory;

  const intents = new FirestoreIntentRepository(db);
  const conversations = new FirestoreConversationRepository(db);
  const recommendations = new FirestoreRecommendationRepository(db);
  const events = new FirestoreCommerceEventRepository(db);
  const outcomes = new FirestoreOutcomeRepository(db);
  const refs = new FirestoreAttributionRefRepository(db);

  for (const i of h.intents) await intents.update(input.brandId, i.intentId, () => i);
  for (const c of h.conversations) await conversations.create(c);
  for (const r of h.recommendations) await recommendations.create(r);
  for (const e of h.events) await events.record(e);
  for (const r of h.reservations) await brand.collection('reservations').doc(r.reservationId).set(reservationToDoc(r));
  for (const o of h.outcomes) await outcomes.createIfAbsent(o);
  for (const r of h.attributionRefs) await refs.create({ ...r, brandId: input.brandId });

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
    for (let i = 0; i < ids.length; i += 400) {
      const batch = db.batch();
      for (const id of ids.slice(i, i + 400))
        batch.update(brand.collection(collection).doc(id), { demo_history: true });
      await batch.commit();
    }
  }
  return { counts };
}
