/** Wire types shared by the server and the web app. */

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  commit: string | null;
  /** Server time as an ISO 8601 UTC string. */
  time: string;
  uptimeSeconds: number;
  db: {
    status: 'ok' | 'error';
    journalMode?: string;
    error?: string;
  };
}

export type ApiErrorCode =
  | 'error'
  | 'internal_error'
  | 'not_found'
  | 'validation_error'
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'forbidden'
  | 'invalid_origin'
  | 'session_locked'
  | 'reauth_required'
  | 'rate_limited'
  | 'setup_closed'
  | 'login_name_taken'
  | 'last_admin'
  | 'invite_invalid'
  | 'challenge_invalid'
  | 'passkey_invalid';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
