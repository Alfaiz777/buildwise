import { Router } from 'express';
import { z } from 'zod';
import type { BrandAssistantService } from '../application/brandAssistantService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import { CONSOLE_PAGES } from '../domain/brandAssistant.js';
import { isValidTenantId } from '../domain/principal.js';
import { AppError, Errors } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';

const AskBody = z.object({
  question: z.string().trim().min(2).max(300),
  page: z.enum(CONSOLE_PAGES).default('OVERVIEW'),
});

/**
 * "Ask Qwikspot" (L5, docs/06 §14.12) — read-only, the principal's own brand only (mounted
 * behind requireScope('BRAND')):
 *   POST /api/brand/assistant/ask                      a question from the drawer (POST: the question is a body, never a URL)
 *   GET  /api/brand/assistant/brief                    the Overview brief (cached 10 min)
 *   GET  /api/brand/conversations/:id/summary          a conversation's summary and handoff brief
 * Every answer arrives within 20 s: Gemini's, or the rules "Quick summary".
 */
export function brandAssistantRouter(assistant: BrandAssistantService): Router {
  const router = Router();
  const perUser = new RateLimiter(20, 60_000);
  const limited = (userId: string) => {
    if (!perUser.hit(userId))
      throw new AppError(429, 'RATE_LIMITED', 'Too many questions in a minute. Try again shortly.', true);
  };

  router.post('/assistant/ask', async (req, res) => {
    const principal = getBrandPrincipal(res);
    const body = AskBody.safeParse(req.body);
    if (!body.success) throw Errors.invalidRequest('Ask a question of 2 to 300 characters.');
    limited(principal.userId);
    res.json(await assistant.ask(principal, body.data.question, body.data.page));
  });

  router.get('/assistant/brief', async (req, res) => {
    const principal = getBrandPrincipal(res);
    const refresh = req.query.refresh === 'true';
    if (refresh) limited(principal.userId);
    res.json(await assistant.brief(principal, { refresh }));
  });

  router.get('/conversations/:conversationId/summary', async (req, res) => {
    const principal = getBrandPrincipal(res);
    const id = req.params.conversationId;
    if (typeof id !== 'string' || !isValidTenantId(id)) throw Errors.notFound();
    res.json(await assistant.conversationSummary(principal, id));
  });

  return router;
}
