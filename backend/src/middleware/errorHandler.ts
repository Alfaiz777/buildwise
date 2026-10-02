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

/** gRPC status codes the Firestore / Firebase Admin SDKs use for "the backend can't be reached". */
const UNAVAILABLE_CODES = new Set([
  4 /* DEADLINE_EXCEEDED */,
  14 /* UNAVAILABLE */,
  'unavailable',
  'deadline-exceeded',
]);

/** A database outage is retryable for the caller: 503 with a safe next step (docs/08 §13, Change 14 G2). */
function fromInfrastructure(err: unknown): AppError | null {
  const code = (err as { code?: unknown })?.code;
  if (code !== undefined && UNAVAILABLE_CODES.has(code as never)) {
    return new AppError(
      503,
      'SERVICE_UNAVAILABLE',
      "Buildwise can't reach its database right now. Please try again in a minute.",
      true,
    );
  }
  return null;
}

/** `includeStack`: local profile only; deployed logs carry the error name and message, not the stack. */
export function errorHandler(logger: Logger, includeStack = true): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const requestId = res.locals.requestId;
    let appError = err instanceof AppError ? err : (fromBodyParser(err) ?? fromInfrastructure(err));
    if (appError?.code === 'SERVICE_UNAVAILABLE') {
      logger.warn('http.dependency_unavailable', {
        request_id: requestId,
        error_code: (err as { code?: unknown }).code,
      });
    }

    if (!appError) {
      // Unexpected: log details server-side, return a generic message.
      // Server log only — the response below never carries the message or a stack trace.
      logger.error('http.unhandled_error', {
        request_id: requestId,
        error_name: (err as Error)?.name,
        error_message: (err as Error)?.message,
        stack: includeStack ? (err as Error)?.stack : undefined,
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
