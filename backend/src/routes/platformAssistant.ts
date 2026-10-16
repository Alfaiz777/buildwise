import { Router } from 'express';
import type { PlatformAssistantService } from '../application/platformAssistantService.js';
import { getPlatformPrincipal } from '../auth/authorize.js';
import { PLATFORM_PAGES } from '../domain/platformAssistant.js';
import { assistantLimiter, parseAsk, parseBriefQuery } from './assistantRequest.js';

/**
 * "Ask Qwikspot" for the Platform Console (L7, docs/06 §14.14) — read-only, PLATFORM_ADMIN only
 * (mounted under /api/platform behind requireScope('PLATFORM'); a Brand or Retail Admin → 403):
 *   POST /api/platform/assistant          a question from the drawer
 *   GET  /api/platform/assistant/brief    "Network today" (cached 10 min)
 * Totals and flags only (docs/07 §4.2): never a brand's customer-level data.
 */
export function platformAssistantRouter(assistant: PlatformAssistantService): Router {
  const router = Router();
  const limited = assistantLimiter();

  router.post('/assistant', async (req, res) => {
    const principal = getPlatformPrincipal(res);
    const ask = parseAsk(PLATFORM_PAGES, 'HOME', req.body);
    limited(principal.userId);
    res.json(await assistant.ask(principal, ask.question, ask.page, ask.scope));
  });

  router.get('/assistant/brief', async (req, res) => {
    const principal = getPlatformPrincipal(res);
    const { refresh, scope } = parseBriefQuery(req.query);
    if (refresh) limited(principal.userId);
    res.json(await assistant.brief({ refresh, scope }));
  });

  return router;
}
