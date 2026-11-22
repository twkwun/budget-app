import type { ApiErrorBody } from '@budget/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiResponse<T> {
  status: number;
  body: T;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * GET a JSON endpoint under /api. Resolves for any JSON response (callers
 * decide what non-2xx means); rejects on network failure, timeout, or a
 * non-JSON body.
 */
export async function getJson<T>(
  path: string,
  options: { timeoutMs?: number } = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`/api${path}`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new ApiError(res.status, 'bad_response', `Unexpected response (${res.status})`);
  }
  return { status: res.status, body: (await res.json()) as T };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.code === 'string'
  );
}
