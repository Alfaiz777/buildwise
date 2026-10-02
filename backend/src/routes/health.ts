import { Router } from 'express';

/**
 * Liveness check. Deliberately has no Firestore/Firebase dependency so a
 * downstream outage does not make Cloud Run restart healthy instances.
 * (Not /healthz: Cloud Run reserves some paths ending in "z".)
 * Reports the build identity (BUILD_VERSION / BUILD_COMMIT from Cloud Build) and the profile.
 */
export function healthRouter(info: { version?: string; commit?: string | null; profile?: string } = {}): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: info.version ?? 'dev',
      commit: info.commit ?? null,
      profile: info.profile ?? 'local',
    });
  });
  return router;
}
