import type { ApiErrorBody, ApiErrorCode } from '@budget/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | 'network_error' | 'bad_response';

  constructor(status: number, code: ApiError['code'], message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Hooks the auth store installs so that every API call handles session
 * problems the same way: sign-in needed, app locked, or step-up required.
 * The two async handlers resolve true when the user has fixed the problem
 * (unlocked / re-verified) and the request should be retried once.
 */
export interface AuthHandlers {
  onUnauthenticated(): void;
  onLocked(): Promise<boolean>;
  onReauthRequired(): Promise<boolean>;
}

let handlers: AuthHandlers | null = null;

export function setAuthHandlers(next: AuthHandlers | null): void {
  handlers = next;
}

export interface RequestOptions {
  /** Do not run the central session handlers (used by the auth flows themselves). */
  raw?: boolean;
  timeoutMs?: number;
  /** Keep the request alive while the page is being hidden or unloaded. */
  keepalive?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.code === 'string'
  );
}

async function send<T>(
  method: string,
  path: string,
  body: unknown,
  options: RequestOptions,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      keepalive: options.keepalive,
      headers: {
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ApiError(0, 'network_error', cause instanceof Error ? cause.message : 'network');
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new ApiError(res.status, 'bad_response', `Unexpected response (${res.status})`);
  }
  const data: unknown = await res.json();
  if (res.ok) return data as T;
  if (isErrorBody(data)) throw new ApiError(res.status, data.error.code, data.error.message);
  throw new ApiError(res.status, 'bad_response', `Request failed (${res.status})`);
}

/** JSON request to /api with central handling of unauthenticated / locked / reauth. */
export async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  try {
    return await send<T>(method, path, body, options);
  } catch (error) {
    if (options.raw || !handlers || !(error instanceof ApiError)) throw error;
    if (error.code === 'unauthenticated') {
      handlers.onUnauthenticated();
      throw error;
    }
    const retry =
      (error.code === 'session_locked' && (await handlers.onLocked())) ||
      (error.code === 'reauth_required' && (await handlers.onReauthRequired()));
    if (!retry) throw error;
    return send<T>(method, path, body, options);
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body: unknown = {}, options?: RequestOptions) =>
    request<T>('POST', path, body, options),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, body, options),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
};

export interface ApiResponse<T> {
  status: number;
  body: T;
}

/**
 * GET a JSON endpoint and resolve for any JSON status (health reports 503
 * with a body). Rejects on network failure, timeout or non-JSON.
 */
export async function getJson<T>(
  path: string,
  options: { timeoutMs?: number } = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`/api${path}`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new ApiError(res.status, 'bad_response', `Unexpected response (${res.status})`);
  }
  return { status: res.status, body: (await res.json()) as T };
}
