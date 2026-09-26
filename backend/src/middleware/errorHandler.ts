import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, Errors } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = () => {
  throw Errors.notFound();
};

/** Body-parser errors carry a `type`; map the common ones to safe client errors. */
function fromBodyParser(err: unknown): AppError | null {
  const type = (err as { type?: unknown }).type;
  if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  if (type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  return null;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const requestId = res.locals.requestId;
    let appError = err instanceof AppError ? err : fromBodyParser(err);

    if (!appError) {
      // Unexpected: log details server-side, return a generic message.
      logger.error('http.unhandled_error', {
        request_id: requestId,
        error_name: (err as Error)?.name,
        error_message: (err as Error)?.message,
        stack: (err as Error)?.stack,
      });
      appError = new AppError(500, 'INTERNAL', 'Something went wrong.', true);
    }

    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        request_id: requestId,
      },
    });
  };
}
