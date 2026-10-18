import { Router } from 'express';
import type { BrandAssistantService } from '../application/brandAssistantService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import { CONSOLE_PAGES } from '../domain/brandAssistant.js';
import { isValidTenantId } from '../domain/principal.js';
import { Errors } from '../lib/errors.js';
import { assistantLimiter, parseAsk, parseBriefQuery } from './assistantRequest.js';

/**
 * "Ask Qwikspot" for the Brand Console (L5, docs/06 §14.12) — read-only, the principal's own
 * brand only (mounted behind requireScope('BRAND')):
 *   POST /api/brand/assistant/ask                      a question from the drawer (POST: the question is a body, never a URL)
 *   GET  /api/brand/assistant/brief                    the Overview brief (cached 10 min)
 *   GET  /api/brand/conversations/:id/summary          a conversation's summary and handoff brief
 * Every answer arrives within 30 s: Gemini's, or the rules "Quick summary".
 */
export function brandAssistantRouter(assistant: BrandAssistantService): Router {
  const router = Router();
  const limited = assistantLimiter();

  router.post('/assistant/ask', async (req, res) => {
    const principal = getBrandPrincipal(res);
    const ask = parseAsk(CONSOLE_PAGES, 'OVERVIEW', req.body);
    limited(principal.userId);
    res.json(await assistant.ask(principal, ask.question, ask.page, ask.scope));
  });

  router.get('/assistant/brief', async (req, res) => {
    const principal = getBrandPrincipal(res);
    const { refresh, scope } = parseBriefQuery(req.query);
    if (refresh) limited(principal.userId);
    res.json(await assistant.brief(principal, { refresh, scope }));
  });

  router.get('/conversations/:conversationId/summary', async (req, res) => {
    const principal = getBrandPrincipal(res);
    const id = req.params.conversationId;
    if (typeof id !== 'string' || !isValidTenantId(id)) throw Errors.notFound();
    res.json(await assistant.conversationSummary(principal, id));
  });

  return router;
}
