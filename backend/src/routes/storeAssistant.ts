import { Router } from 'express';
import type { StoreAssistantService } from '../application/storeAssistantService.js';
import { getRetailPrincipal } from '../auth/authorize.js';
import { STORE_PAGES } from '../domain/storeAssistant.js';
import { Errors } from '../lib/errors.js';
import { assistantLimiter, parseAsk, parseBriefQuery } from './assistantRequest.js';

/**
 * "Ask Qwikspot" for the Store Console (L6, docs/06 §14.13) — read-only, RETAIL_ADMIN, the
 * principal's own store only (mounted under /api/retail behind requireScope('RETAIL')):
 *   POST /api/retail/stores/:storeId/assistant         a question from the drawer
 *   GET  /api/retail/stores/:storeId/assistant/brief   "Today at your store" (cached 10 min)
 * Any other store → 404. The store is the principal's; a store id in the question is never read.
 */
export function storeAssistantRouter(assistant: StoreAssistantService): Router {
  const router = Router();
  const limited = assistantLimiter();
  const ownStore = (storeId: unknown, res: Parameters<typeof getRetailPrincipal>[0]) => {
    const principal = getRetailPrincipal(res);
    if (typeof storeId !== 'string' || storeId !== principal.storeId) throw Errors.notFound();
    return principal;
  };

  router.post('/stores/:storeId/assistant', async (req, res) => {
    const principal = ownStore(req.params.storeId, res);
    const ask = parseAsk(STORE_PAGES, 'TODAY', req.body);
    limited(principal.userId);
    res.json(await assistant.ask(principal, ask.question, ask.page, ask.scope));
  });

  router.get('/stores/:storeId/assistant/brief', async (req, res) => {
    const principal = ownStore(req.params.storeId, res);
    const { refresh, scope } = parseBriefQuery(req.query);
    if (refresh) limited(principal.userId);
    res.json(await assistant.brief(principal, { refresh, scope }));
  });

  return router;
}
