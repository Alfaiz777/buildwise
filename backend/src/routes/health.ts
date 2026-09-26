import { Router } from 'express';

/**
 * Liveness check. Deliberately has no Firestore/Firebase dependency so a
 * downstream outage does not make Cloud Run restart healthy instances.
 * (Not /healthz: Cloud Run reserves some paths ending in "z".)
 */
export function healthRouter(): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  return router;
}
