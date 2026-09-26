import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { bearer, buildTestApp, FakeVerifier, MemoryBrands, MemoryUsers } from './helpers.js';

const app = buildTestApp();

describe('app foundation', () => {
  it('GET /api/health is public and needs no Firebase', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('sets a request ID and no-store on every response', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('uses the common error envelope with the request ID', async () => {
    const res = await request(app).get('/api/me');
    expect(res.body).toEqual({
      error: {
        code: 'AUTH_REQUIRED',
        message: expect.any(String),
        retryable: false,
        request_id: res.headers['x-request-id'],
      },
    });
  });

  it('returns 404 NOT_FOUND for unknown non-API routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('requires authentication before revealing whether an /api route exists', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(401);
  });

  it('rejects bodies over 100 KB (413)', async () => {
    const res = await request(app)
      .post('/api/me')
      .set('Authorization', bearer('admin_a'))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(110 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects malformed JSON (400)', async () => {
    const res = await request(app)
      .post('/api/me')
      .set('Authorization', bearer('admin_a'))
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('access log records the full path and never the token or query string', async () => {
    const lines: string[] = [];
    const loggedApp = createApp({
      config: { corsAllowedOrigins: [] },
      logger: createLogger('info', (line) => lines.push(line)),
      verifier: new FakeVerifier({}),
      users: new MemoryUsers([]),
      brands: new MemoryBrands([]),
    });
    await request(loggedApp).get('/api/me?secret=abc').set('Authorization', 'Bearer super-secret-token');
    const access = lines.map((l) => JSON.parse(l)).find((l) => l.message === 'http.request');
    expect(access).toMatchObject({ severity: 'INFO', path: '/api/me', status: 401 });
    expect(lines.join('\n')).not.toContain('super-secret-token');
    expect(lines.join('\n')).not.toContain('secret=abc');
  });

  it('sends no CORS headers unless origins are configured', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows only configured CORS origins', async () => {
    const corsApp = buildTestApp({ corsAllowedOrigins: ['https://app.buildwise.test'] });
    const ok = await request(corsApp).get('/api/health').set('Origin', 'https://app.buildwise.test');
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.buildwise.test');
    const bad = await request(corsApp).get('/api/health').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});
