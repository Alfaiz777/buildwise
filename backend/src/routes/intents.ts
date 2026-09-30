import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { IntentService } from '../application/intentService.js';
import { WEB_EVENT_TYPES } from '../domain/intentClassification.js';
import { AppError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';

/**
 * POST /api/intents — PUBLIC storefront intent endpoint (docs/06_INTEGRATION_CONTRACTS.md
 * §14.1, docs/07_SECURITY_SPEC.md §17). No PII is accepted: the body is strict, so any
 * unexpected field (name, phone, email, …) is rejected. The Origin must be in the brand's
 * allowed_storefront_origins. Cross-origin storefronts (the real Shopify theme) get CORS
 * headers only for allowed origins.
 */

const OPAQUE_ID = /^[A-Za-z0-9_-]{8,64}$/;

const IntentEvent = z
  .object({
    brand_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    web_session_id: z.string().regex(OPAQUE_ID),
    visitor_id: z.string().regex(OPAQUE_ID).optional(),
    client_event_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    event_type: z.enum(WEB_EVENT_TYPES),
    shopify_variant_id: z.string().min(1).max(200).optional(),
    search_term: z.string().max(200).optional(),
    entry: z.enum(['STORE_NEED', 'CHAT']).optional(),
    occurred_at: z.string().max(40).optional(),
  })
  .strict();

const invalidEvent = () => new AppError(400, 'INVALID_EVENT', 'The event is not valid.');
const rateLimited = () => new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', true);

export function intentsRouter(
  service: IntentService,
  limits = { perIp: new RateLimiter(60, 60_000), perBrand: new RateLimiter(600, 60_000) },
): Router {
  const router = Router();

  // CORS preflight: allowed for any origin; the POST itself is checked against the brand's allowlist.
  router.options('/intents', (req, res) => {
    const origin = req.get('origin');
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
    res.status(204).end();
  });

  router.post('/intents', express.json({ limit: '4kb' }), async (req: Request, res) => {
    if (!limits.perIp.hit(`ip:${req.ip}`)) throw rateLimited();
    const parsed = IntentEvent.safeParse(req.body);
    if (!parsed.success) throw invalidEvent();
    const body = parsed.data;

    const origin = req.get('origin');
    const brand = await service.brandForOrigin(body.brand_id, origin);
    res.set('Access-Control-Allow-Origin', origin!);
    res.set('Vary', 'Origin');
    if (!limits.perBrand.hit(`brand:${brand.brandId}`)) throw rateLimited();

    const result = await service.recordEvent(brand, {
      brandId: brand.brandId,
      webSessionId: body.web_session_id,
      visitorId: body.visitor_id ?? null,
      clientEventId: body.client_event_id,
      eventType: body.event_type,
      shopifyVariantId: body.shopify_variant_id ?? null,
      searchTerm: body.search_term ?? null,
      entry: body.entry ?? null,
    });
    res.status(202).json({
      accepted: true,
      intent_stage: result.intent.stage,
      intent_strength: result.intent.strength,
      intent_type: result.intent.type,
      whatsapp: result.whatsapp
        ? {
            prefilled_text: result.whatsapp.prefilledText,
            wa_link: result.whatsapp.waLink,
            expires_at: result.whatsapp.expiresAt,
          }
        : null,
    });
  });

  return router;
}
