import type { ApiErrorCode } from '@budget/shared';

/** An error that maps directly to an API error response. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly headers: Record<string, string>;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

export const errors = {
  validation: (message = 'Invalid request') => new HttpError(400, 'validation_error', message),
  unauthenticated: () => new HttpError(401, 'unauthenticated', 'Sign-in required'),
  invalidCredentials: () =>
    new HttpError(401, 'invalid_credentials', 'Sign-in failed. Check your details and try again.'),
  forbidden: (message = 'Not allowed') => new HttpError(403, 'forbidden', message),
  reauthRequired: () => new HttpError(403, 'reauth_required', 'Confirm your identity to continue'),
  invalidOrigin: () => new HttpError(403, 'invalid_origin', 'Request origin not allowed'),
  notFound: (message = 'Not found') => new HttpError(404, 'not_found', message),
  conflict: (code: ApiErrorCode, message: string) => new HttpError(409, code, message),
  gone: (code: ApiErrorCode, message: string) => new HttpError(410, code, message),
  locked: () => new HttpError(423, 'session_locked', 'The app is locked'),
  rateLimited: (retryAfterSeconds: number) =>
    new HttpError(429, 'rate_limited', 'Too many attempts. Try again later.', {
      'retry-after': String(retryAfterSeconds),
    }),
};
