/** Authentication rules and DTOs shared by the server and the web app. */
import type { UserRole } from './domain.ts';

/** Lowercase letters, digits, `.`, `_`, `-`; 3–32 characters, starting with a letter or digit. */
export const LOGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const DISPLAY_NAME_MAX_LENGTH = 30;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const PASSKEY_NAME_MAX_LENGTH = 40;

export function normalizeLoginName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * App-lock choices (DESIGN 4.1): 즉시 / 5분 / 1시간 / 끔.
 * `0` locks whenever the app is hidden (plus a short server-side backstop);
 * `null` disables the lock.
 */
export const LOCK_TIMEOUT_CHOICES = [
  { value: 0, label: '즉시' },
  { value: 300, label: '5분' },
  { value: 3600, label: '1시간' },
  { value: null, label: '끔' },
] as const;
export type LockTimeout = (typeof LOCK_TIMEOUT_CHOICES)[number]['value'];

export function isLockTimeout(value: unknown): value is LockTimeout {
  return LOCK_TIMEOUT_CHOICES.some((choice) => choice.value === value);
}

export interface Me {
  id: number;
  loginName: string;
  displayName: string;
  role: UserRole;
  lockTimeoutSeconds: LockTimeout;
  createdAt: string;
}

export interface AuthState {
  /** True until the first admin has been created. */
  setupRequired: boolean;
  authenticated: boolean;
  locked: boolean;
  user: Me | null;
}

export interface SignedIn {
  user: Me;
}

/** Returned exactly once; the server keeps only a hash. */
export interface RecoveryCodeIssued {
  recoveryCode: string;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
}

export interface PasskeyInfo {
  id: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** True for synced passkeys (e.g. iCloud Keychain). */
  backedUp: boolean;
}

export interface MemberInfo {
  id: number;
  loginName: string;
  displayName: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  passkeyCount: number;
}

export type InviteStatus = 'pending' | 'used' | 'expired' | 'revoked';

export interface InviteInfo {
  id: number;
  role: UserRole;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  usedBy: string | null;
}

export interface CreatedInvite {
  invite: InviteInfo;
  /** Shareable link containing the one-time token; shown once. */
  url: string;
}

export interface InviteCheck {
  valid: boolean;
  expiresAt: string | null;
}
