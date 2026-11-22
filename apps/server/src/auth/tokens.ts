import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Crockford-style alphabet without I, L, O, U to avoid misreading.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 characters from a 32-symbol alphabet = 80 bits, shown as XXXX-XXXX-XXXX-XXXX. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  let code = '';
  bytes.forEach((byte, i) => {
    if (i > 0 && i % 4 === 0) code += '-';
    code += RECOVERY_ALPHABET[byte & 31];
  });
  return code;
}

/** Canonical form for hashing: uppercase, separators removed, look-alikes folded. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

export function hashRecoveryCode(code: string): string {
  return sha256(`recovery:${normalizeRecoveryCode(code)}`);
}
