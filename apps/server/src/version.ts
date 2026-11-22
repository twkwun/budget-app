import { readFileSync } from 'node:fs';

export interface AppVersion {
  version: string;
  commit: string | null;
}

/** Version from this package's package.json (works from both src/ and dist/). */
export function readPackageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}
