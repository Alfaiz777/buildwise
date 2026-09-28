import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../lib/logger.js';

/**
 * Assigns a request ID (returned as X-Request-Id and in error envelopes),
 * marks API responses non-cacheable, and writes one access-log line per request.
 * The log line never includes headers, so tokens are never logged.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');

    res.on('finish', () => {
      logger.info('http.request', {
        request_id: requestId,
        method: req.method,
        // Full path without the query string (req.path is relative to the router mount).
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        latency_ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
        user_id: res.locals.principal?.userId,
        scope: res.locals.principal?.scope,
        brand_id: res.locals.principal && 'brandId' in res.locals.principal ? res.locals.principal.brandId : undefined,
      });
    });
    next();
  };
}
