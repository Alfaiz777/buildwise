import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../api/client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('createApiClient', () => {
  it('sends the Firebase ID token as a Bearer token and no brand_id', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json(200, { ok: true }));
    const api = createApiClient({
      baseUrl: '',
      getIdToken: async () => 'id-token-1',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(api.get('/api/me')).resolves.toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/me');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer id-token-1');
    expect(url).not.toContain('brand');
  });

  it('prefixes a configured base URL', async () => {
    const fetchImpl = vi.fn(async (_url: string) => json(200, {}));
    const api = createApiClient({
      baseUrl: 'https://api.example.test',
      getIdToken: async () => 't',
      fetchImpl: fetchImpl as typeof fetch,
    });
    await api.get('/api/me');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.test/api/me');
  });

  it('retries once with a force-refreshed token after a 401', async () => {
    const getIdToken = vi.fn(async (force: boolean) => (force ? 'fresh' : 'stale'));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { code: 'AUTH_EXPIRED', message: 'expired' } }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const api = createApiClient({ baseUrl: '', getIdToken, fetchImpl });

    await expect(api.get('/api/me')).resolves.toEqual({ ok: true });
    expect(getIdToken.mock.calls).toEqual([[false], [true]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not loop: a second 401 becomes an ApiError', async () => {
    const fetchImpl = vi.fn(async () => json(401, { error: { code: 'AUTH_INVALID', message: 'bad' } }));
    const api = createApiClient({ baseUrl: '', getIdToken: async () => 't', fetchImpl });
    await expect(api.get('/api/me')).rejects.toMatchObject({ status: 401, code: 'AUTH_INVALID' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('parses the error envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      json(403, { error: { code: 'FORBIDDEN', message: 'No.', retryable: false, request_id: 'r-9' } }),
    );
    const api = createApiClient({ baseUrl: '', getIdToken: async () => 't', fetchImpl });
    const err = await api.get('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'No.', requestId: 'r-9' });
  });

  it('handles non-JSON errors (e.g. an HTML 502 from a proxy)', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const api = createApiClient({ baseUrl: '', getIdToken: async () => 't', fetchImpl });
    await expect(api.get('/api/me')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR', retryable: true });
  });

  it('fails without calling the network when signed out', async () => {
    const fetchImpl = vi.fn();
    const api = createApiClient({ baseUrl: '', getIdToken: async () => null, fetchImpl });
    await expect(api.get('/api/me')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
