import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ShopperChannelService } from '../application/shopperChannel.js';
import { AppError, Errors } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { parseInput } from '../lib/validation.js';

/**
 * /api/shopper/* — the shopper demo channel (Change 16, UI-2), PUBLIC like the storefront.
 * Mounted in the local profile, and in gcp only with DEMO_MODE on; in gcp only the
 * allowlisted demo brands answer (others → 404). The customer ref is never accepted from
 * the browser: it comes from the signed session token in `X-Qwikspot-Shopper-Session`.
 * POSTs must come from the brand's allowed storefront origin; bodies are strict.
 */
export const SHOPPER_SESSION_HEADER = 'x-qwikspot-shopper-session';

const BRAND_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const StartSession = z.object({ brand_id: BRAND_ID, shopper_id: z.string().min(1).max(100).optional() }).strict();
const Content = z.discriminatedUnion('type', [
  z.object({ type: z.literal('TEXT'), text: z.string().trim().min(1).max(1000) }).strict(),
  z
    .object({
      type: z.literal('LOCATION'),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .strict(),
  z.object({ type: z.literal('INTERACTIVE_REPLY'), option_id: z.string().min(1).max(200) }).strict(),
]);
const SendMessage = z
  .object({ client_message_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), content: Content })
  .strict();
const MESSAGE_ID = /^msg_[0-9a-z]{9,40}$/;

export function shopperRouter(shopper: ShopperChannelService): Router {
  const router = Router();
  const sessionsPerIp = new RateLimiter(20, 60_000);
  const messagesPerIp = new RateLimiter(60, 60_000);
  const messagesPerSession = new RateLimiter(20, 60_000);
  const pollsPerSession = new RateLimiter(60, 60_000);
  const tooMany = () => new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.', true);
  const session = (req: Request) => shopper.verify(req.get(SHOPPER_SESSION_HEADER));

  router.post('/session', async (req, res) => {
    if (!sessionsPerIp.hit(req.ip ?? 'unknown')) throw tooMany();
    const body = parseInput(StartSession, req.body);
    res
      .status(201)
      .json(
        await shopper.start({ brandId: body.brand_id, shopperId: body.shopper_id ?? null, origin: req.get('origin') }),
      );
  });

  router.post('/messages', async (req, res) => {
    if (!messagesPerIp.hit(req.ip ?? 'unknown')) throw tooMany();
    const s = session(req);
    if (!messagesPerSession.hit(`${s.brandId}:${s.customerRef}`)) throw tooMany();
    const body = parseInput(SendMessage, req.body);
    res.json(
      await shopper.send(s, req.get('origin'), { clientMessageId: body.client_message_id, content: body.content }),
    );
  });

  router.get('/messages', async (req, res) => {
    const s = session(req);
    if (!pollsPerSession.hit(`${s.brandId}:${s.customerRef}`)) throw tooMany();
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    if (after !== undefined && !MESSAGE_ID.test(after)) throw Errors.invalidRequest('after must be a message id.');
    res.json(await shopper.messages(s, after));
  });

  return router;
}
