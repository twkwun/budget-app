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

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
