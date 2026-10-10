import express, { Router } from 'express';
import type { SyncActor } from '../application/commerceSyncService.js';
import { shopifyNotConfigured, type ShopifyAuthService } from '../application/shopifyAuthService.js';
import type { ShopifyOrderService } from '../application/shopifyOrderService.js';
import type { ShopifyWebhookService } from '../application/shopifyWebhookService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import { AppError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { connectionJson } from './catalog.js';

const rateLimited = () => new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', true);

/**
 * BRAND_ADMIN (mounted behind requireScope('BRAND') at /api/integrations):
 *   POST /shopify/connect { shop } → { authorize_url }
 *   POST /shopify/disconnect       → the connection status (never a token)
 *   POST /shopify/orders/sync      → { checked, recorded, cancelled } (the order check)
 * Without COMMERCE_PROVIDER=shopify they answer 409 SHOPIFY_NOT_CONFIGURED.
 */
export function shopifyBrandRouter(
  auth: ShopifyAuthService | undefined,
  orders: ShopifyOrderService | undefined,
): Router {
  const router = Router();
  const perBrand = new RateLimiter(10, 60_000);
  router.post('/shopify/connect', async (req, res) => {
    if (!auth) throw shopifyNotConfigured();
    const principal = getBrandPrincipal(res);
    if (!perBrand.hit(principal.brandId)) throw rateLimited();
    const { authorizeUrl } = await auth.connect(principal, req.body?.shop);
    res.json({ authorize_url: authorizeUrl });
  });
  router.post('/shopify/disconnect', async (_req, res) => {
    if (!auth) throw shopifyNotConfigured();
    res.json(connectionJson(await auth.disconnect(getBrandPrincipal(res))));
  });
  router.post('/shopify/orders/sync', async (_req, res) => {
    if (!orders) throw shopifyNotConfigured();
    const principal = getBrandPrincipal(res);
    if (!perBrand.hit(principal.brandId)) throw rateLimited();
    res.json(await orders.check(principal.brandId, { type: 'USER', id: principal.userId }));
  });
  return router;
}

/**
 * After a Shopify "Sync products": bring the store's webhooks up to date (a store connected
 * before a topic was added gets it without reconnecting) and check for missed orders. Best
 * effort — the sync itself already succeeded, so a failure here never fails the request.
 */
export function afterShopifySync(
  auth: ShopifyAuthService | undefined,
  orders: ShopifyOrderService | undefined,
): ((brandId: string, actor: SyncActor) => Promise<void>) | undefined {
  if (!auth || !orders) return undefined;
  return async (brandId, actor) => {
    await auth.ensureWebhooks(brandId);
    await orders.check(brandId, actor).catch(() => undefined);
  };
}

/** PUBLIC: GET /api/integrations/shopify/callback — Shopify redirects the browser here. */
export function shopifyCallbackRouter(auth: ShopifyAuthService): Router {
  const router = Router();
  const perIp = new RateLimiter(30, 60_000);
  router.get('/integrations/shopify/callback', async (req, res) => {
    if (!perIp.hit(`ip:${req.ip}`)) throw rateLimited();
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') query[k] = v;
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.redirect(302, await auth.callback(query));
  });
  return router;
}

/**
 * PUBLIC: POST /api/webhooks/shopify. Mounted BEFORE express.json so the HMAC is checked
 * on the exact raw bytes Shopify signed.
 */
export function shopifyWebhookRouter(webhooks: ShopifyWebhookService): Router {
  const router = Router();
  router.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await webhooks.handle(raw, {
      hmac: req.get('X-Shopify-Hmac-Sha256') ?? undefined,
      topic: req.get('X-Shopify-Topic') ?? undefined,
      shopDomain: req.get('X-Shopify-Shop-Domain') ?? undefined,
      eventId: req.get('X-Shopify-Event-Id') ?? undefined,
      webhookId: req.get('X-Shopify-Webhook-Id') ?? undefined,
    });
    if (result.status === 401) {
      res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature.', retryable: false } });
      return;
    }
    res.status(200).json({ received: true });
  });
  return router;
}
