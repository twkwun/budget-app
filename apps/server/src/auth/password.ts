import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * scrypt parameters. The defaults follow OWASP's scrypt guidance
 * (N=2^16, r=8, p=2, about 64 MiB per hash), which stays practical on a
 * low-end NAS. Parameters are stored inside each hash so they can be raised
 * later; `needsRehash` reports hashes made with weaker settings.
 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 16, r: 8, p: 2, keyLength: 32 };

/** Cheap parameters for tests only. */
export const TEST_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 10, r: 8, p: 1, keyLength: 32 };

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * params.p + 32 * 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, params.keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Format: `scrypt$N=65536,r=8,p=2$<salt b64url>$<key b64url>`. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, params);
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
  const values = Object.fromEntries(
    (parts[1] ?? '').split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, Number(v)];
    }),
  ) as Record<string, number>;
  const { N, r, p } = values;
  const key = Buffer.from(parts[3] ?? '', 'base64url');
  if (!N || !r || !p || key.length === 0) return null;
  return {
    params: { N, r, p, keyLength: key.length },
    salt: Buffer.from(parts[2] ?? '', 'base64url'),
    key,
  };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

export function needsRehash(stored: string, params: ScryptParams): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return (
    parsed.params.N < params.N ||
    parsed.params.r < params.r ||
    parsed.params.p < params.p ||
    parsed.params.keyLength < params.keyLength
  );
}

/**
 * Verifies against a fixed dummy hash so that a sign-in attempt for an unknown
 * or unusable account costs the same time as one for a real account.
 */
export class PasswordHasher {
  readonly params: ScryptParams;
  private dummy: Promise<string> | null = null;

  constructor(params: ScryptParams = DEFAULT_SCRYPT_PARAMS) {
    this.params = params;
  }

  hash(password: string): Promise<string> {
    return hashPassword(password, this.params);
  }

  async verify(password: string, stored: string | null | undefined): Promise<boolean> {
    if (!stored) {
      this.dummy ??= hashPassword('dummy-password-for-timing', this.params);
      await verifyPassword(password, await this.dummy);
      return false;
    }
    return verifyPassword(password, stored);
  }

  needsRehash(stored: string): boolean {
    return needsRehash(stored, this.params);
  }
}
