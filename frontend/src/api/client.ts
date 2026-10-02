/** Error returned by the Qwikspot API (common error envelope). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Returns the current user's Firebase ID token, or null when signed out. */
export type GetIdToken = (forceRefresh: boolean) => Promise<string | null>;

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  /**
   * PUTs a file to an upload target returned by the backend. A same-origin API path
   * (the local profile's /api/local-files/uploads/...) gets the Bearer token; an absolute
   * signed URL (Cloud Storage in gcp) is used as-is, without Qwikspot credentials.
   */
  upload<T>(url: string, file: Blob, contentType: string): Promise<T>;
}

type Method = 'GET' | 'POST' | 'PATCH';

interface ErrorEnvelope {
  error?: { code?: string; message?: string; retryable?: boolean; request_id?: string };
}

/**
 * Minimal authenticated API client.
 * - attaches `Authorization: Bearer <Firebase ID token>` to every call
 * - on 401 retries once with a force-refreshed token (covers clock skew / just-expired tokens)
 * - never sends brand_id: the backend derives the tenant from the token
 */
export function createApiClient(options: {
  baseUrl: string;
  getIdToken: GetIdToken;
  fetchImpl?: typeof fetch;
}): ApiClient {
  const { baseUrl, getIdToken } = options;
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function send(method: Method, path: string, body: unknown, forceRefresh: boolean): Promise<Response> {
    const token = await getIdToken(forceRefresh);
    if (!token) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.', false, null);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function toError(res: Response): Promise<ApiError> {
    let body: ErrorEnvelope = {};
    try {
      body = (await res.json()) as ErrorEnvelope;
    } catch {
      // Non-JSON error (e.g. proxy/HTML page): fall through to a generic error.
    }
    return new ApiError(
      res.status,
      body.error?.code ?? 'HTTP_ERROR',
      body.error?.message ?? `Request failed (${res.status}).`,
      body.error?.retryable ?? res.status >= 500,
      body.error?.request_id ?? res.headers.get('X-Request-Id'),
    );
  }

  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    let res = await send(method, path, body, false);
    if (res.status === 401) res = await send(method, path, body, true);
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    upload: async <T>(url: string, file: Blob, contentType: string) => {
      const sameOrigin = url.startsWith('/');
      const put = async (forceRefresh: boolean) => {
        const headers: Record<string, string> = { 'Content-Type': contentType, Accept: 'application/json' };
        if (sameOrigin) {
          const token = await getIdToken(forceRefresh);
          if (!token) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.', false, null);
          headers.Authorization = `Bearer ${token}`;
        }
        return fetchImpl(sameOrigin ? `${baseUrl}${url}` : url, { method: 'PUT', headers, body: file });
      };
      let res = await put(false);
      if (res.status === 401 && sameOrigin) res = await put(true);
      if (!res.ok) throw await toError(res);
      return (await res.json().catch(() => ({}))) as T;
    },
  };
}
