import { WhatsAppApiError, type WhatsAppGraphApi, type WhatsAppPhoneNumberInfo } from '../../ports/whatsapp.js';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

interface GraphError {
  error?: { code?: number; error_subcode?: number; type?: string };
}

const PHONE_FIELDS = 'display_phone_number,verified_name,quality_rating';

/**
 * Meta's Graph API over HTTPS for WhatsApp (L2-WhatsApp; docs/06 §10, §17.1 S2), version
 * pinned by config. Errors are normalized: never Meta's message, a token or the app secret.
 */
export class HttpWhatsAppGraphApi implements WhatsAppGraphApi {
  private readonly fetch: FetchFn;
  private readonly base: string;

  constructor(
    private readonly app: { appId: string | null; appSecret: string; graphVersion: string },
    options: { fetch?: FetchFn; baseUrl?: string } = {},
  ) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.base = `${(options.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '')}/${app.graphVersion}`;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string | null,
    body?: object,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new WhatsAppApiError('FAILED', 'Meta could not be reached.');
    }
    const json = (await res.json().catch(() => ({}))) as T & GraphError;
    if (res.ok && !json.error) return json;
    const code = typeof json.error?.code === 'number' ? json.error.code : null;
    if (res.status === 401 || code === 190)
      throw new WhatsAppApiError('UNAUTHORIZED', 'Meta rejected the token.', code);
    if (res.status === 404 || code === 100) throw new WhatsAppApiError('NOT_FOUND', 'Meta did not find it.', code);
    if (res.status === 429 || code === 4 || code === 80007 || code === 130429)
      throw new WhatsAppApiError('RATE_LIMITED', 'Meta is busy. Try again shortly.', code);
    if (res.status === 400) throw new WhatsAppApiError('INVALID', 'Meta refused the request.', code);
    throw new WhatsAppApiError('FAILED', 'Meta returned an error.', code);
  }

  async exchangeCode(code: string): Promise<string> {
    if (!this.app.appId) throw new WhatsAppApiError('INVALID', 'META_APP_ID is not configured.');
    const q = new URLSearchParams({ client_id: this.app.appId, client_secret: this.app.appSecret, code });
    const r = await this.call<{ access_token?: string }>('GET', `/oauth/access_token?${q}`, null);
    if (!r.access_token) throw new WhatsAppApiError('FAILED', 'Meta returned no token.');
    return r.access_token;
  }

  private info(r: { id?: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }) {
    return {
      id: String(r.id ?? ''),
      displayPhoneNumber: r.display_phone_number ?? '',
      verifiedName: r.verified_name ?? '',
      qualityRating: r.quality_rating ?? 'UNKNOWN',
    };
  }

  async getPhoneNumber(phoneNumberId: string, token: string): Promise<WhatsAppPhoneNumberInfo> {
    return this.info(await this.call('GET', `/${encodeURIComponent(phoneNumberId)}?fields=${PHONE_FIELDS}`, token));
  }

  async listPhoneNumbers(wabaId: string, token: string): Promise<WhatsAppPhoneNumberInfo[]> {
    const r = await this.call<{ data?: object[] }>(
      'GET',
      `/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,${PHONE_FIELDS}`,
      token,
    );
    return (r.data ?? []).map((x) => this.info(x));
  }

  async subscribeApp(wabaId: string, token: string): Promise<void> {
    await this.call('POST', `/${encodeURIComponent(wabaId)}/subscribed_apps`, token);
  }

  async unsubscribeApp(wabaId: string, token: string): Promise<void> {
    await this.call('DELETE', `/${encodeURIComponent(wabaId)}/subscribed_apps`, token);
  }

  async registerNumber(phoneNumberId: string, token: string, pin: string): Promise<void> {
    await this.call('POST', `/${encodeURIComponent(phoneNumberId)}/register`, token, {
      messaging_product: 'whatsapp',
      pin,
    });
  }

  async sendMessage(phoneNumberId: string, token: string, payload: Record<string, unknown>): Promise<string> {
    const r = await this.call<{ messages?: { id?: string }[] }>(
      'POST',
      `/${encodeURIComponent(phoneNumberId)}/messages`,
      token,
      payload,
    );
    const id = r.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError('FAILED', 'Meta returned no message id.');
    return id;
  }
}
