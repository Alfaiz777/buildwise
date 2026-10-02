/** The seed:live guard (Change 14, G8): every refusal, and what a valid run would do. */
import { describe, expect, it } from 'vitest';
import { checkSeedLive, confirmationMatches } from '../scripts/seedLiveGuard.js';
import { LOCAL_DEMO_PASSWORD } from '../src/config/env.js';

const OK_ENV = {
  DEMO_MODE: 'true',
  DEMO_PASSWORD: 'a-long-judged-demo-secret',
  GOOGLE_CLOUD_PROJECT: 'qwikspot-judge',
};
const check =
  (args: { project?: string; brand?: string }, env: Record<string, string | undefined> = OK_ENV) =>
  () =>
    checkSeedLive({ args, env });

describe('seed:live guard', () => {
  it.each([
    ['no --project', {}, OK_ENV, /--project <id> is required/],
    ['an invalid project id', { project: 'Not A Project' }, OK_ENV, /not a valid/],
    ['--project ≠ GOOGLE_CLOUD_PROJECT', { project: 'other-project' }, OK_ENV, /does not match/],
    ['DEMO_MODE off', { project: 'qwikspot-judge' }, { ...OK_ENV, DEMO_MODE: 'false' }, /DEMO_MODE=true/],
    ['no DEMO_PASSWORD', { project: 'qwikspot-judge' }, { ...OK_ENV, DEMO_PASSWORD: undefined }, /DEMO_PASSWORD/],
    ['a short DEMO_PASSWORD', { project: 'qwikspot-judge' }, { ...OK_ENV, DEMO_PASSWORD: 'short' }, /12 characters/],
    [
      'a brand outside DEMO_BRAND_IDS',
      { project: 'qwikspot-judge', brand: 'brd_customer' },
      OK_ENV,
      /not in DEMO_BRAND_IDS/,
    ],
  ])('refuses %s', (_name, args, env, message) => {
    expect(check(args, env)).toThrow(message);
  });

  it('the repo password is refused even though it is long enough', () => {
    expect(LOCAL_DEMO_PASSWORD.length).toBeGreaterThanOrEqual(12);
    expect(check({ project: 'qwikspot-judge' }, { ...OK_ENV, DEMO_PASSWORD: LOCAL_DEMO_PASSWORD })).toThrow(
      /not be the local demo password/,
    );
  });

  it('a valid run targets the demo brand and the four demo users', () => {
    const plan = checkSeedLive({ args: { project: 'qwikspot-judge' }, env: OK_ENV });
    expect(plan).toMatchObject({
      projectId: 'qwikspot-judge',
      brandId: 'brd_demo',
      emails: {
        platform: 'platform@qwikspot.test',
        brandAdmin: 'admin@demo-brand.test',
        retailAdmins: [
          ['st_north_1', 'retail-admin-north-1@qwikspot.test'],
          ['st_north_2', 'retail-admin-north-2@qwikspot.test'],
        ],
      },
    });
  });

  it('the typed confirmation must repeat the project id exactly', () => {
    expect(confirmationMatches('qwikspot-judge', 'qwikspot-judge')).toBe(true);
    expect(confirmationMatches(' qwikspot-judge \n', 'qwikspot-judge')).toBe(true);
    expect(confirmationMatches('yes', 'qwikspot-judge')).toBe(false);
    expect(confirmationMatches(undefined, 'qwikspot-judge')).toBe(false);
  });
});
