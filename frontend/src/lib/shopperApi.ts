import type { ChatMessage } from '../pages/brand/conversationTypes';

/**
 * The shopper demo channel client (Change 16). The server issues the shopper's chat
 * identity as a signed session token; this tab keeps it in sessionStorage and sends it in
 * a header. The browser never sends a customer ref.
 */
export const SHOPPER_SESSION_HEADER = 'X-Qwikspot-Shopper-Session';

export interface ShopperBrand {
  brand_id: string;
  display_name: string;
  logo_url: string | null;
}
interface StoredSession {
  token: string;
  expiresAt: string;
  brand: ShopperBrand;
  /** Which demo shopper this session is for (null = guest). */
  shopperId: string | null;
}

export type ShopperMessage = Omit<ChatMessage, 'origin' | 'message_kind' | 'template_name'> & {
  from: 'SHOPPER' | 'BRAND';
  origin?: ChatMessage['origin'];
  message_kind?: ChatMessage['message_kind'];
  template_name?: string | null;
};

const key = (brandId: string) => `qs_shopper_session:${brandId}`;

function read(brandId: string): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(key(brandId));
    const s = raw ? (JSON.parse(raw) as StoredSession) : null;
    return s && Date.parse(s.expiresAt) > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}

function write(brandId: string, s: StoredSession | null) {
  try {
    if (s) window.sessionStorage.setItem(key(brandId), JSON.stringify(s));
    else window.sessionStorage.removeItem(key(brandId));
  } catch {
    // storage blocked: the session lives for this page view only
  }
}

export class ShopperApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  if (!res.ok)
    throw new ShopperApiError(res.status, body.error?.code ?? 'HTTP_ERROR', body.error?.message ?? 'Request failed.');
  return body as T;
}

export const newClientMessageId = () => `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/** A chat session for one brand in this tab: started on demand, re-started when it expires. */
export class ShopperChat {
  private session: StoredSession | null;
  private memory: StoredSession | null = null;

  constructor(private readonly brandId: string) {
    this.session = read(brandId);
  }

  /** UI-6: the current session token, for the demo storefront's shopper sign-in. */
  get sessionToken(): string | null {
    return (this.session ?? this.memory)?.token ?? null;
  }

  get brand(): ShopperBrand | null {
    return (this.session ?? this.memory)?.brand ?? null;
  }

  /** Starts a session (as a guest, or as a synthetic demo shopper) and keeps it for this tab. */
  async start(shopperId: string | null = null): Promise<ShopperBrand> {
    const res = await fetch('/api/shopper/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand_id: this.brandId, ...(shopperId ? { shopper_id: shopperId } : {}) }),
    });
    const body = await json<{ session_token: string; expires_at: string; brand: ShopperBrand }>(res);
    const s: StoredSession = { token: body.session_token, expiresAt: body.expires_at, brand: body.brand, shopperId };
    this.session = s;
    this.memory = s;
    write(this.brandId, s);
    return body.brand;
  }

  private async token(): Promise<string> {
    if (!this.session) await this.start();
    return this.session!.token;
  }

  private async call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const res = await fetch(`/api/shopper${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), [SHOPPER_SESSION_HEADER]: await this.token() },
    });
    if (res.status === 401 && !retried) {
      // The session ended (expiry or a server restart): start a fresh guest session once.
      this.session = null;
      write(this.brandId, null);
      return this.call(path, init, true);
    }
    return json<T>(res);
  }

  send(content: object): Promise<{ conversation_id: string; messages: ShopperMessage[] }> {
    return this.call('/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_message_id: newClientMessageId(), content }),
    });
  }

  messages(after?: string): Promise<{ conversation_id: string | null; messages: ShopperMessage[] }> {
    return this.call(`/messages${after ? `?after=${encodeURIComponent(after)}` : ''}`);
  }
}
