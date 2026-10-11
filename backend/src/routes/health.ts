import { Router } from 'express';

/**
 * Liveness check. Deliberately has no Firestore/Firebase dependency so a
 * downstream outage does not make Cloud Run restart healthy instances.
 * (Not /healthz: Cloud Run reserves some paths ending in "z".)
 * Reports the build identity (BUILD_VERSION / BUILD_COMMIT from Cloud Build), the profile and
 * (UI-5) which adapters are selected — names only.
 */
export interface HealthAdapters {
  agent_runtime: 'MOCK' | 'GEMINI';
  channels: ('SIMULATOR' | 'WHATSAPP')[];
  commerce: 'MOCK' | 'SHOPIFY';
}

export function healthRouter(
  info: {
    version?: string;
    commit?: string | null;
    profile?: string;
    adapters?: HealthAdapters;
    /** L1 staged rollout: the stand-in adapters a gcp deployment runs, e.g. ["AGENT_RUNTIME=mock"]. */
    staged?: string[];
  } = {},
): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: info.version ?? 'dev',
      commit: info.commit ?? null,
      profile: info.profile ?? 'local',
      // UI-5 System card: which adapters run (names only — never hosts, keys or ids).
      adapters: info.adapters ?? { agent_runtime: 'MOCK', channels: ['SIMULATOR'], commerce: 'MOCK' },
      staged: info.staged ?? [],
    });
  });
  return router;
}
