/**
 * L1: POST /api/internal/process-due — Cloud Scheduler's due work, authenticated by a Google
 * OIDC token for the scheduler service account and audience = this endpoint (docs/12 §9).
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { FakeOidcVerifier, buildTestWorld } from './helpers.js';

const call = (app: Parameters<typeof request>[0], token?: string) => {
  const r = request(app).post('/api/internal/process-due');
  return token === undefined ? r : r.set('Authorization', `Bearer ${token}`);
};

describe('POST /api/internal/process-due (Cloud Scheduler, OIDC)', () => {
  it.each([
    ['no token', undefined],
    ['a malformed header', 'not a token!'],
    ['an invalid signature', 'forged-token'],
    ['the wrong audience', 'wrong-audience-token'],
    ['another service account', 'other-account-token'],
    ['an unverified email', 'unverified-email-token'],
  ])('%s → 401, nothing runs', async (_name, token) => {
    const world = buildTestWorld({ schedulerVerifier: new FakeOidcVerifier() });
    const before = world.audit.brandEvents.length;
    const res = await call(world.app, token);
    expect([res.status, res.body.error.code]).toEqual([401, 'AUTH_INVALID']);
    expect(world.audit.brandEvents.length).toBe(before);
  });

  it('a valid scheduler token runs the due work for every ACTIVE brand, audited as the SYSTEM actor', async () => {
    const world = buildTestWorld({ schedulerVerifier: new FakeOidcVerifier() });
    const active = world.brands.brands.filter((b) => b.status === 'ACTIVE').map((b) => b.brandId);
    const res = await call(world.app, 'valid-scheduler-token');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ brands: active.length, failed: 0, sent: 0 });
    const runs = world.audit.brandEvents.filter((e) => e.action === 'DUE_WORK_PROCESSED');
    expect(runs.map((e) => e.brandId).sort()).toEqual([...active].sort());
    for (const e of runs)
      expect(e).toMatchObject({ actorType: 'SYSTEM', actorId: 'cloud-scheduler', result: 'SUCCESS' });
  });

  it('is rate-limited', async () => {
    const world = buildTestWorld({ schedulerVerifier: new FakeOidcVerifier() });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await call(world.app, 'valid-scheduler-token')).status);
    expect(codes.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(codes.slice(6)).toEqual([429, 429]);
  });

  it('without a configured scheduler identity it is just the console API: no Firebase user → 401, nothing runs', async () => {
    const world = buildTestWorld();
    expect((await call(world.app, 'valid-scheduler-token')).status).toBe(401);
    expect(world.audit.brandEvents.filter((e) => e.action === 'DUE_WORK_PROCESSED')).toHaveLength(0);
  });
});
