import { Router, type Request } from 'express';
import { z } from 'zod';
import type { DemoStorefrontService } from '../application/demoStorefrontService.js';
import type { IntentService } from '../application/intentService.js';
import { AppError, Errors } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { parseInput } from '../lib/validation.js';

/**
 * /api/demo-storefront/* — mounted only when the composition root wires the
 * DemoStorefrontService: the local profile, or gcp with DEMO_MODE on (Change 16), where
 * only the allowlisted demo brands answer (`brandAllowed`; others → 404). Public like the storefront itself;
 * POSTs must come from an allowed storefront origin. No PII is accepted: the shopper is
 * chosen from the synthetic commerce fixture and linked server-side.
 */

const OPAQUE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const BRAND_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const SignIn = z
  .object({
    brand_id: BRAND_ID,
    shopper_id: z.string().min(1).max(100),
    visitor_id: z.string().regex(OPAQUE_ID),
    web_session_id: z.string().regex(OPAQUE_ID),
  })
  .strict();

const Order = z
  .object({
    brand_id: BRAND_ID,
    web_session_id: z.string().regex(OPAQUE_ID),
    shopify_variant_id: z.string().min(1).max(200).optional(),
    /** M6: the attribution reference from the "Buy online" link (opaque; validated server-side). */
    qs_ref: z.string().min(1).max(64).optional(),
  })
  .strict();

export function demoStorefrontRouter(
  demo: DemoStorefrontService,
  intents: IntentService,
  brandAllowed: (brandId: string) => boolean = () => true,
): Router {
  const router = Router();
  const perIp = new RateLimiter(120, 60_000);

  const limit = (req: Request) => {
    if (!perIp.hit(`demo:${req.ip}`)) throw new AppError(429, 'RATE_LIMITED', 'Too many requests.', true);
  };
  /** POSTs must come from an allowed storefront origin of an active brand. */
  const brandFor = (req: Request, brandId: string) => {
    if (!brandAllowed(brandId)) throw Errors.notFound();
    return intents.brandForOrigin(brandId, req.get('origin'));
  };

  // Same-origin GETs carry no Origin header; a cross-origin GET is still checked.
  router.get('/products', async (req, res) => {
    limit(req);
    const brandId = typeof req.query.brand_id === 'string' ? req.query.brand_id : '';
    if (!BRAND_ID.safeParse(brandId).success || !brandAllowed(brandId)) throw Errors.notFound();
    if (req.get('origin')) await intents.brandForOrigin(brandId, req.get('origin'));
    res.json({ products: await demo.products(brandId) });
  });

  router.get('/shoppers', async (req, res) => {
    limit(req);
    res.json({ shoppers: await demo.shoppers() });
  });

  router.post('/shopper-sign-in', async (req, res) => {
    limit(req);
    const body = parseInput(SignIn, req.body);
    const brand = await brandFor(req, body.brand_id);
    res.json(
      await demo.signInShopper(brand.brandId, {
        shopperId: body.shopper_id,
        visitorId: body.visitor_id,
        webSessionId: body.web_session_id,
      }),
    );
  });

  router.post('/orders', async (req, res) => {
    limit(req);
    const body = parseInput(Order, req.body);
    const brand = await brandFor(req, body.brand_id);
    const result = await demo.placeOrder(brand.brandId, {
      webSessionId: body.web_session_id,
      shopifyVariantId: body.shopify_variant_id ?? null,
      attributionRef: body.qs_ref ?? null,
    });
    res.status(201).json({
      order_recorded: true,
      intent_converted: result.intentConverted,
      attributed: result.attributed,
      outcome_recorded: result.outcomeRecorded,
    });
  });

  return router;
}
