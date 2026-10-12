import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { SealedSecret, TokenCipher } from '../../lib/tokenCipher.js';
import type { WhatsAppConnection, WhatsAppConnectionStore } from '../../ports/whatsapp.js';

/**
 * Server-only WhatsApp storage (L2-WhatsApp; docs/04, docs/07 §6):
 *   whatsapp_connections/{brandId}     — the connection; business token and 2-step PIN sealed (AES-256-GCM)
 *   whatsapp_numbers/{phoneNumberId}   — { brand_id }: one number belongs to one brand
 * Top-level, so Reset demo (which wipes only brands/{id}/… and its own top-level docs) keeps them.
 * Firestore rules deny every client.
 */
export class FirestoreWhatsAppConnectionStore implements WhatsAppConnectionStore {
  constructor(
    private readonly db: Firestore,
    private readonly cipher: TokenCipher,
  ) {}

  private conn(brandId: string) {
    return this.db.collection('whatsapp_connections').doc(brandId);
  }

  private number(phoneNumberId: string) {
    return this.db.collection('whatsapp_numbers').doc(phoneNumberId);
  }

  async get(brandId: string): Promise<WhatsAppConnection | null> {
    const snap = await this.conn(brandId).get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    if (d.status === 'DISCONNECTED' || !d.business_token) return null;
    return {
      brandId,
      wabaId: d.waba_id,
      phoneNumberId: d.phone_number_id,
      displayPhoneNumber: d.display_phone_number ?? '',
      verifiedName: d.verified_name ?? '',
      qualityRating: d.quality_rating ?? 'UNKNOWN',
      status: d.status,
      businessToken: this.cipher.open(d.business_token as SealedSecret),
      pin: d.pin ? this.cipher.open(d.pin as SealedSecret) : '',
      connectedAt: d.connected_at,
      updatedAt: d.updated_at_iso ?? d.connected_at,
    };
  }

  async save(c: WhatsAppConnection): Promise<boolean> {
    const connRef = this.conn(c.brandId);
    const numberRef = this.number(c.phoneNumberId);
    return this.db.runTransaction(async (tx) => {
      const [claim, previous] = await Promise.all([tx.get(numberRef), tx.get(connRef)]);
      if (claim.exists && claim.get('brand_id') !== c.brandId) return false;
      const oldNumber = previous.exists ? (previous.get('phone_number_id') as string | undefined) : undefined;
      if (oldNumber && oldNumber !== c.phoneNumberId) tx.delete(this.number(oldNumber));
      tx.set(numberRef, { phone_number_id: c.phoneNumberId, brand_id: c.brandId, waba_id: c.wabaId });
      tx.set(connRef, {
        brand_id: c.brandId,
        waba_id: c.wabaId,
        phone_number_id: c.phoneNumberId,
        display_phone_number: c.displayPhoneNumber,
        verified_name: c.verifiedName,
        quality_rating: c.qualityRating,
        status: c.status,
        business_token: this.cipher.seal(c.businessToken),
        pin: this.cipher.seal(c.pin),
        connected_at: c.connectedAt,
        updated_at_iso: c.updatedAt,
        updated_at: FieldValue.serverTimestamp(),
      });
      return true;
    });
  }

  async updateStatus(
    brandId: string,
    patch: Partial<Pick<WhatsAppConnection, 'status' | 'qualityRating' | 'verifiedName'>> & { updatedAt: string },
  ): Promise<void> {
    const ref = this.conn(brandId);
    const snap = await ref.get();
    if (!snap.exists || snap.get('status') === 'DISCONNECTED') return;
    await ref.update({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.qualityRating ? { quality_rating: patch.qualityRating } : {}),
      ...(patch.verifiedName ? { verified_name: patch.verifiedName } : {}),
      updated_at_iso: patch.updatedAt,
      updated_at: FieldValue.serverTimestamp(),
    });
  }

  async disconnect(brandId: string, at: string): Promise<void> {
    const ref = this.conn(brandId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const phoneNumberId = snap.get('phone_number_id') as string | undefined;
      if (phoneNumberId) {
        const claim = await tx.get(this.number(phoneNumberId));
        if (claim.exists && claim.get('brand_id') === brandId) tx.delete(claim.ref);
      }
      tx.update(ref, {
        status: 'DISCONNECTED',
        business_token: FieldValue.delete(),
        pin: FieldValue.delete(),
        updated_at_iso: at,
        updated_at: FieldValue.serverTimestamp(),
      });
    });
  }

  async brandForPhoneNumber(phoneNumberId: string): Promise<string | null> {
    if (!/^\d{5,20}$/.test(phoneNumberId)) return null;
    const snap = await this.number(phoneNumberId).get();
    return snap.exists ? (snap.get('brand_id') as string) : null;
  }

  async recordDeliveryStatus(
    brandId: string,
    update: { externalMessageId: string; status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'; timestamp: string },
  ): Promise<void> {
    if (!/^[A-Za-z0-9._=:-]{6,200}$/.test(update.externalMessageId)) return;
    const rank = { SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 } as const;
    const ref = this.db.collection('brands').doc(brandId).collection('messageStatuses').doc(update.externalMessageId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? (snap.get('status') as keyof typeof rank) : null;
      if (current && rank[current] >= rank[update.status]) return;
      tx.set(ref, {
        brand_id: brandId,
        external_message_id: update.externalMessageId,
        status: update.status,
        status_at: update.timestamp,
      });
    });
  }

  async brandsForWaba(wabaId: string): Promise<string[]> {
    const snap = await this.db.collection('whatsapp_numbers').where('waba_id', '==', wabaId).limit(20).get();
    return [...new Set(snap.docs.map((d) => d.get('brand_id') as string))];
  }
}
