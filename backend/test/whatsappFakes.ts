/**
 * L2-WhatsApp test doubles (no network). FakeMeta answers the real HttpWhatsAppGraphApi's
 * requests like Meta's Graph API and records them; MemoryWhatsAppStore seals tokens and PINs
 * with the real TokenCipher, like the Firestore store.
 */
import { createHmac } from 'node:crypto';
import { TokenCipher, type SealedSecret } from '../src/lib/tokenCipher.js';
import type { WhatsAppConnection, WhatsAppConnectionStore } from '../src/ports/whatsapp.js';

export const META_TEST_APP = {
  appId: '1234567890123',
  appSecret: ['test', 'meta', 'app', 'secret', '0123456789'].join('-'),
  esConfigId: '9876543210987',
  graphVersion: 'v26.0',
  verifyToken: 'test-verify-token',
  devNumber: null as { accessToken: string; phoneNumberId: string } | null,
};

/** A WABA with numbers, reachable with the token its signup code exchanges to. */
export interface FakeWaba {
  wabaId: string;
  code: string;
  token: string;
  numbers: { id: string; display: string; name: string; quality?: string }[];
}

export interface SeenGraphRequest {
  method: string;
  path: string;
  token: string | null;
  body: Record<string, unknown> | null;
}

export class FakeMeta {
  readonly seen: SeenGraphRequest[] = [];
  readonly subscribed = new Set<string>();
  readonly registered = new Map<string, string>(); // phone number id → PIN
  readonly sent: { phoneNumberId: string; token: string; payload: Record<string, unknown> }[] = [];
  /** Tokens Meta now rejects (190). */
  readonly revoked = new Set<string>();
  /** The next send fails with this Meta error code (e.g. 131047 outside the window). */
  sendErrorCode: number | null = null;
  private wamid = 0;

  constructor(readonly wabas: FakeWaba[] = []) {}

  private wabaForToken(token: string | null) {
    return this.wabas.find((w) => w.token === token && !this.revoked.has(token)) ?? null;
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v\d+\.0/, '');
    const auth = new Headers(init.headers).get('Authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const method = init.method ?? 'GET';
    this.seen.push({ method, path: `${path}${u.search}`, token, body });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    const graphError = (status: number, code: number) =>
      json(status, { error: { message: 'Meta says no (raw message must never leak)', code, type: 'OAuthException' } });

    if (path === '/oauth/access_token') {
      const ok =
        u.searchParams.get('client_id') === META_TEST_APP.appId &&
        u.searchParams.get('client_secret') === META_TEST_APP.appSecret;
      const waba = this.wabas.find((w) => w.code === u.searchParams.get('code'));
      return ok && waba ? json(200, { access_token: waba.token, token_type: 'bearer' }) : graphError(400, 100);
    }

    const waba = this.wabaForToken(token);
    if (!waba) return graphError(401, 190);
    const [, first, second] = path.split('/');
    if (second === 'phone_numbers' && first === waba.wabaId && method === 'GET') {
      return json(200, {
        data: waba.numbers.map((n) => ({
          id: n.id,
          display_phone_number: n.display,
          verified_name: n.name,
          quality_rating: n.quality ?? 'GREEN',
        })),
      });
    }
    if (second === 'subscribed_apps' && first === waba.wabaId) {
      if (method === 'POST') this.subscribed.add(waba.wabaId);
      if (method === 'DELETE') this.subscribed.delete(waba.wabaId);
      return json(200, { success: true });
    }
    const number = waba.numbers.find((n) => n.id === first);
    if (!number) return graphError(404, 100);
    if (!second && method === 'GET') {
      return json(200, {
        id: number.id,
        display_phone_number: number.display,
        verified_name: number.name,
        quality_rating: number.quality ?? 'GREEN',
      });
    }
    if (second === 'register' && method === 'POST') {
      if (body?.messaging_product !== 'whatsapp' || !/^\d{6}$/.test(String(body.pin))) return graphError(400, 100);
      this.registered.set(number.id, String(body.pin));
      return json(200, { success: true });
    }
    if (second === 'messages' && method === 'POST') {
      if (this.sendErrorCode !== null) {
        const code = this.sendErrorCode;
        this.sendErrorCode = null;
        return graphError(400, code);
      }
      this.sent.push({ phoneNumberId: number.id, token: token!, payload: body! });
      return json(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: body?.to, wa_id: body?.to }],
        messages: [{ id: `wamid.TEST${++this.wamid}` }],
      });
    }
    return graphError(400, 100);
  };
}

export class MemoryWhatsAppStore implements WhatsAppConnectionStore {
  readonly docs = new Map<string, Record<string, unknown>>();
  readonly numbers = new Map<string, { brandId: string; wabaId: string }>();
  readonly statuses = new Map<string, { status: string; timestamp: string }>();
  constructor(private readonly cipher = new TokenCipher(Buffer.alloc(32, 9))) {}

  async get(brandId: string): Promise<WhatsAppConnection | null> {
    const d = this.docs.get(brandId);
    if (!d || d.status === 'DISCONNECTED' || !d.business_token) return null;
    return {
      brandId,
      wabaId: d.waba_id as string,
      phoneNumberId: d.phone_number_id as string,
      displayPhoneNumber: d.display_phone_number as string,
      verifiedName: d.verified_name as string,
      qualityRating: d.quality_rating as string,
      status: d.status as WhatsAppConnection['status'],
      businessToken: this.cipher.open(d.business_token as SealedSecret),
      pin: this.cipher.open(d.pin as SealedSecret),
      connectedAt: d.connected_at as string,
      updatedAt: d.updated_at as string,
    };
  }

  async save(c: WhatsAppConnection): Promise<boolean> {
    const holder = this.numbers.get(c.phoneNumberId);
    if (holder && holder.brandId !== c.brandId) return false;
    const old = this.docs.get(c.brandId)?.phone_number_id as string | undefined;
    if (old && old !== c.phoneNumberId) this.numbers.delete(old);
    this.numbers.set(c.phoneNumberId, { brandId: c.brandId, wabaId: c.wabaId });
    this.docs.set(c.brandId, {
      waba_id: c.wabaId,
      phone_number_id: c.phoneNumberId,
      display_phone_number: c.displayPhoneNumber,
      verified_name: c.verifiedName,
      quality_rating: c.qualityRating,
      status: c.status,
      business_token: this.cipher.seal(c.businessToken),
      pin: this.cipher.seal(c.pin),
      connected_at: c.connectedAt,
      updated_at: c.updatedAt,
    });
    return true;
  }

  async updateStatus(
    brandId: string,
    patch: Partial<Pick<WhatsAppConnection, 'status' | 'qualityRating' | 'verifiedName'>> & { updatedAt: string },
  ) {
    const d = this.docs.get(brandId);
    if (!d || d.status === 'DISCONNECTED') return;
    if (patch.status) d.status = patch.status;
    if (patch.qualityRating) d.quality_rating = patch.qualityRating;
    if (patch.verifiedName) d.verified_name = patch.verifiedName;
    d.updated_at = patch.updatedAt;
  }

  async disconnect(brandId: string, at: string) {
    const d = this.docs.get(brandId);
    if (!d) return;
    const number = d.phone_number_id as string;
    if (this.numbers.get(number)?.brandId === brandId) this.numbers.delete(number);
    Object.assign(d, { status: 'DISCONNECTED', business_token: null, pin: null, updated_at: at });
  }

  async brandForPhoneNumber(phoneNumberId: string) {
    return this.numbers.get(phoneNumberId)?.brandId ?? null;
  }

  async brandsForWaba(wabaId: string) {
    return [...new Set([...this.numbers.values()].filter((n) => n.wabaId === wabaId).map((n) => n.brandId))];
  }

  async recordDeliveryStatus(
    brandId: string,
    update: { externalMessageId: string; status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'; timestamp: string },
  ) {
    const rank = { SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 } as Record<string, number>;
    const key = `${brandId}:${update.externalMessageId}`;
    const current = this.statuses.get(key);
    if (current && rank[current.status]! >= rank[update.status]!) return;
    this.statuses.set(key, { status: update.status, timestamp: update.timestamp });
  }
}

/** X-Hub-Signature-256 for a raw webhook body. */
export const metaSignature = (raw: string, secret = META_TEST_APP.appSecret) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

/** A Cloud API webhook body: one `messages` change for one phone number id. */
export function waWebhook(
  phoneNumberId: string,
  value: { messages?: object[]; statuses?: object[] },
  field = 'messages',
  entryId = 'waba-entry',
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: entryId,
        changes: [
          {
            field,
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export const waText = (from: string, id: string, body: string, ts = '1791800000') => ({
  from,
  id,
  timestamp: ts,
  type: 'text',
  text: { body },
});
