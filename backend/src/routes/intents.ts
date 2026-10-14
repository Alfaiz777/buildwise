import { randomBytes } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { IntentService } from '../application/intentService.js';
import { WEB_EVENT_TYPES } from '../domain/intentClassification.js';
import { AppError } from '../lib/errors.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { RateLimiter } from '../lib/rateLimiter.js';

/**
 * POST /api/intents — PUBLIC storefront intent endpoint (docs/06_INTEGRATION_CONTRACTS.md
 * §14.1, docs/07_SECURITY_SPEC.md §17). No PII is accepted: the body is strict, so any
 * unexpected field (name, phone, email, …) is rejected. The Origin must be in the brand's
 * allowed_storefront_origins. Cross-origin storefronts (the real Shopify theme) get CORS
 * headers only for allowed origins — on error responses too, so the browser can read them.
 * Mounted BEFORE the app's global CORS middleware (app.ts): that list is the console's own
 * origins and would otherwise answer a storefront's preflight without CORS headers.
 *
 * GET /api/wa — L4, the WhatsApp entry points on a storefront are plain links to this redirect,
 * so a tap navigates at once (phones keep the tap's permission to open the WhatsApp app). It
 * records the WHATSAPP_CLICK exactly like POST /intents, then answers 302 to the wa.me link.
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

/** GET /api/wa: strictly these fields (the same id rules as IntentEvent). */
const WaQuery = z
  .object({
    brand: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    entry: z.enum(['STORE_NEED', 'CHAT']),
    variant: z
      .string()
      .regex(/^(\d{1,20}|gid:\/\/shopify\/ProductVariant\/\d{1,20})$/)
      .optional(),
    session: z.string().regex(OPAQUE_ID),
    visitor: z.string().regex(OPAQUE_ID).optional(),
  })
  .strict();

/** "https://shop.example.com/products/x" → "https://shop.example.com"; null when it is not an http(s) URL. */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

const invalidEvent = () => new AppError(400, 'INVALID_EVENT', 'The event is not valid.');
const rateLimited = () => new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', true);

export function intentsRouter(
  service: IntentService,
  limits = { perIp: new RateLimiter(60, 60_000), perBrand: new RateLimiter(600, 60_000) },
  logger: Logger = silentLogger,
): Router {
  const router = Router();

  /** CORS headers for a storefront origin the brand allows — set before anything can fail. */
  const allowCors = async (req: Request, res: Response, brandId: unknown) => {
    const origin = req.get('origin');
    if (origin && typeof brandId === 'string' && (await service.isOriginAllowed(brandId, origin))) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
  };

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
    await allowCors(req, res, (req.body as { brand_id?: unknown } | undefined)?.brand_id);
    if (!limits.perIp.hit(`ip:${req.ip}`)) throw rateLimited();
    const parsed = IntentEvent.safeParse(req.body);
    if (!parsed.success) throw invalidEvent();
    const body = parsed.data;

    const origin = req.get('origin');
    const brand = await service.brandForOrigin(body.brand_id, origin);
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
      // L4: the storefront hides its WhatsApp entry points only when this says false.
      whatsapp_available: result.whatsappAvailable,
      whatsapp: result.whatsapp
        ? {
            prefilled_text: result.whatsapp.prefilledText,
            // The reference for clients that can send it invisibly (simulator); not in the wa.me text.
            ref: result.whatsapp.ref,
            wa_link: result.whatsapp.waLink,
            expires_at: result.whatsapp.expiresAt,
          }
        : null,
    });
  });

  router.get('/wa', async (req: Request, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const parsed = WaQuery.safeParse(req.query);
    if (!parsed.success) throw invalidEvent();
    const q = parsed.data;
    const brand = await service.activeBrand(q.brand);
    if (!brand) throw new AppError(404, 'NOT_FOUND', 'Not found.');

    // A link cannot send an Origin header: the referring page's origin is checked instead
    // (browsers send it cross-origin under the default strict-origin-when-cross-origin).
    const referer = req.get('referer');
    const origin = originOf(referer);
    const allowed = await service.isOriginAllowed(brand.brandId, origin);

    let reason: string;
    if (!allowed) reason = 'ORIGIN_NOT_ALLOWED';
    else if (!limits.perIp.hit(`ip:${req.ip}`) || !limits.perBrand.hit(`brand:${brand.brandId}`))
      reason = 'RATE_LIMITED';
    else {
      try {
        const result = await service.recordEvent(brand, {
          brandId: brand.brandId,
          webSessionId: q.session,
          visitorId: q.visitor ?? null,
          clientEventId: `ce_wa_${randomBytes(9).toString('hex')}`,
          eventType: 'WHATSAPP_CLICK',
          shopifyVariantId: q.variant ? `gid://shopify/ProductVariant/${q.variant.replace(/^\D+/, '')}` : null,
          searchTerm: null,
          entry: q.entry,
        });
        if (result.whatsappAvailable && result.whatsapp?.waLink) return res.redirect(302, result.whatsapp.waLink);
        reason = 'NO_WHATSAPP_NUMBER';
      } catch (err) {
        reason = err instanceof AppError ? err.code : 'ERROR';
      }
    }

    // The click could not be recorded: still open the brand's chat (no reference), or go back.
    const plain = await service.plainWhatsappLink(brand);
    logger.warn('intents.wa_redirect_fallback', { brand_id: brand.brandId, reason, to: plain ? 'WHATSAPP' : 'BACK' });
    if (plain) return res.redirect(302, plain);
    if (referer && allowed) return res.redirect(302, referer);
    throw new AppError(404, 'WHATSAPP_NOT_AVAILABLE', 'This brand cannot be reached on WhatsApp.');
  });

  return router;
}
