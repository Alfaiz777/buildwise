/**
 * Normalized API error. Serialized with the common error envelope
 * (docs/06_INTEGRATION_CONTRACTS.md §14):
 *   { "error": { "code", "message", "retryable", "request_id" } }
 * `message` must always be safe to show to the user.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  authRequired: () => new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.'),
  authInvalid: () => new AppError(401, 'AUTH_INVALID', 'Your session is invalid. Sign in again.'),
  authExpired: () => new AppError(401, 'AUTH_EXPIRED', 'Your session has expired. Sign in again.'),
  authUnavailable: () =>
    new AppError(503, 'AUTH_UNAVAILABLE', 'Sign-in verification is temporarily unavailable.', true),
  userNotProvisioned: () =>
    new AppError(403, 'USER_NOT_PROVISIONED', 'Your account has not been set up for Qwikspot yet.'),
  userDisabled: () => new AppError(403, 'USER_DISABLED', 'Your account is disabled.'),
  userMisconfigured: () =>
    new AppError(403, 'USER_MISCONFIGURED', 'Your account is not configured correctly. Contact your administrator.'),
  brandInactive: () => new AppError(403, 'BRAND_INACTIVE', 'Your brand is suspended. Contact Qwikspot support.'),
  retailerInactive: () => new AppError(403, 'RETAILER_INACTIVE', 'Your retailer account is not active.'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.'),
  notFound: () => new AppError(404, 'NOT_FOUND', 'Not found.'),
  invalidRequest: (message = 'The request is not valid.') => new AppError(400, 'INVALID_REQUEST', message),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  unprocessable: (code: string, message: string) => new AppError(422, code, message),
};
