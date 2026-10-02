/**
 * The guard in front of `npm run seed:live` (Change 14, G8). Pure, so it is unit-tested.
 * Writing demo data into a real project needs, all at once:
 *   --project <id>                 the target, which must equal GOOGLE_CLOUD_PROJECT when set;
 *   a typed confirmation           the same id again (interactively, or --confirm <id>);
 *   DEMO_MODE=true                 a judged demo deployment, never a customer project;
 *   DEMO_PASSWORD                  ≥ 12 characters and NOT the local repo password;
 *   the brand in DEMO_BRAND_IDS    only an allowlisted demo brand is (re)built.
 * Nothing is printed back except names — never the password.
 */
import { LOCAL_DEMO_PASSWORD } from '../src/config/env.js';

export class SeedLiveRefused extends Error {}

export interface SeedLivePlan {
  projectId: string;
  brandId: string;
  password: string;
  emails: { platform: string; brandAdmin: string; retailAdmins: [storeId: string, email: string][] };
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function checkSeedLive(input: {
  args: { project?: string; brand?: string };
  env: Record<string, string | undefined>;
}): SeedLivePlan {
  const { args, env } = input;
  const projectId = args.project?.trim();
  if (!projectId) throw new SeedLiveRefused('--project <id> is required');
  if (!PROJECT_ID.test(projectId)) throw new SeedLiveRefused('--project is not a valid Google Cloud project id');
  if (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_PROJECT !== projectId) {
    throw new SeedLiveRefused('--project does not match GOOGLE_CLOUD_PROJECT');
  }
  if (env.DEMO_MODE !== 'true') throw new SeedLiveRefused('DEMO_MODE=true is required (judged demo deployments only)');

  const password = env.DEMO_PASSWORD ?? '';
  if (password.length < 12) throw new SeedLiveRefused('DEMO_PASSWORD must be set (at least 12 characters)');
  if (password === LOCAL_DEMO_PASSWORD) {
    throw new SeedLiveRefused('DEMO_PASSWORD must not be the local demo password from the repository');
  }

  const brandId = args.brand?.trim() || 'brd_demo';
  const allowlist = (env.DEMO_BRAND_IDS ?? 'brd_demo')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowlist.includes(brandId)) throw new SeedLiveRefused(`${brandId} is not in DEMO_BRAND_IDS`);

  return {
    projectId,
    brandId,
    password,
    emails: {
      platform: env.DEMO_PLATFORM_ADMIN_EMAIL ?? 'platform@buildwise.test',
      brandAdmin: env.DEMO_BRAND_ADMIN_EMAIL ?? 'admin@demo-brand.test',
      retailAdmins: [
        ['st_north_1', env.DEMO_RETAIL_ADMIN_1_EMAIL ?? 'retail-admin-north-1@buildwise.test'],
        ['st_north_2', env.DEMO_RETAIL_ADMIN_2_EMAIL ?? 'retail-admin-north-2@buildwise.test'],
      ],
    },
  };
}

/** The typed confirmation must repeat the project id exactly. */
export function confirmationMatches(typed: string | undefined, projectId: string): boolean {
  return (typed ?? '').trim() === projectId;
}
