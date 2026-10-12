import express, { Router } from 'express';
import type { WhatsAppConnections } from '../application/whatsappConnections.js';
import type { WhatsAppWebhookService } from '../application/whatsappWebhookService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import { AppError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';

const rateLimited = () => new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', true);
const notConfigured = () =>
  new AppError(409, 'WHATSAPP_NOT_CONFIGURED', 'WhatsApp is not enabled on this server (MESSAGING_CHANNELS).');

/**
 * BRAND_ADMIN (behind requireScope('BRAND') at /api/integrations; the brand is the principal's):
 *   GET  /whatsapp             → status, the number masked
 *   POST /whatsapp/connect     { code, waba_id, phone_number_id? } (Embedded Signup result)
 *   POST /whatsapp/disconnect
 * Without the whatsapp channel they answer 409 WHATSAPP_NOT_CONFIGURED (GET: NOT_CONNECTED).
 */
export function whatsappBrandRouter(connections: WhatsAppConnections | undefined): Router {
  const router = Router();
  const perBrand = new RateLimiter(10, 60_000);
  router.get('/whatsapp', async (_req, res) => {
    if (!connections) {
      res.json({ enabled: false, status: 'NOT_CONNECTED', display_phone_number: null, verified_name: null });
      return;
    }
    res.json({ enabled: true, ...(await connections.status(getBrandPrincipal(res).brandId)) });
  });
  router.post('/whatsapp/connect', async (req, res) => {
    if (!connections) throw notConfigured();
    const principal = getBrandPrincipal(res);
    if (!perBrand.hit(principal.brandId)) throw rateLimited();
    res.json({ enabled: true, ...(await connections.connect(principal, req.body ?? {})) });
  });
  router.post('/whatsapp/disconnect', async (_req, res) => {
    if (!connections) throw notConfigured();
    const principal = getBrandPrincipal(res);
    if (!perBrand.hit(principal.brandId)) throw rateLimited();
    res.json({ enabled: true, ...(await connections.disconnect(principal)) });
  });
  return router;
}

/** PUBLIC: GET /api/public/meta-config → the public ids the Facebook SDK needs (never a secret). */
export function metaConfigRouter(
  meta: { appId: string | null; esConfigId: string | null; graphVersion: string } | null,
) {
  const router = Router();
  router.get('/public/meta-config', (_req, res) => {
    if (!meta?.appId || !meta.esConfigId) {
      res.json({ available: false, app_id: null, config_id: null, graph_version: meta?.graphVersion ?? null });
      return;
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ available: true, app_id: meta.appId, config_id: meta.esConfigId, graph_version: meta.graphVersion });
  });
  return router;
}

/**
 * PUBLIC: GET/POST /api/webhooks/whatsapp. Mounted BEFORE express.json: the signature is
 * checked on the exact raw bytes Meta signed (also through the Firebase Hosting rewrite,
 * which forwards the body unchanged).
 */
export function whatsappWebhookRouter(webhooks: WhatsAppWebhookService): Router {
  const router = Router();
  router.get('/webhooks/whatsapp', (req, res) => {
    const challenge = webhooks.verifySubscription(req.query as Record<string, unknown>);
    if (challenge === null) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Verification failed.', retryable: false } });
      return;
    }
    res.type('text/plain').send(challenge);
  });
  router.post('/webhooks/whatsapp', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!webhooks.accept(req.headers, raw)) {
      res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature.', retryable: false } });
      return;
    }
    res.status(200).json({ received: true });
  });
  return router;
}
