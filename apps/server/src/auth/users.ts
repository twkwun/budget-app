import { and, count, eq, isNull } from 'drizzle-orm';
import {
  DISPLAY_NAME_MAX_LENGTH,
  LOGIN_NAME_PATTERN,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  normalizeLoginName,
  type LockTimeout,
  type Me,
} from '@budget/shared';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { AppDatabase } from '../db/client.ts';
import { users } from '../db/schema.ts';
import type { UserRow } from './sessions.ts';

/** Consecutive failures before a temporary per-account lockout. */
export const MAX_FAILED_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;

export const loginNameSchema = z
  .string()
  .transform(normalizeLoginName)
  .pipe(z.string().regex(LOGIN_NAME_PATTERN, 'invalid login name'));
export const displayNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH);
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export function toMe(user: UserRow): Me {
  return {
    id: user.id,
    loginName: user.loginName,
    displayName: user.displayName,
    role: user.role,
    lockTimeoutSeconds: (user.lockTimeoutSeconds ?? null) as LockTimeout,
    createdAt: user.createdAt.toISOString(),
  };
}

export function countUsers(db: Pick<AppDatabase, 'select'>): number {
  return db.select({ n: count() }).from(users).get()?.n ?? 0;
}

export function countActiveAdmins(db: Pick<AppDatabase, 'select'>): number {
  return (
    db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
      .get()?.n ?? 0
  );
}

export function findUserByLoginName(db: AppDatabase, loginName: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.loginName, loginName)).get();
}

/** Active (not disabled) and not inside a lockout window. */
export function canAttemptPassword(user: UserRow | undefined, now: number): user is UserRow {
  return !!user && !user.disabledAt && !(user.lockedUntil && user.lockedUntil.getTime() > now);
}

export function recordFailedAttempt(ctx: AppContext, user: UserRow): void {
  const failed = user.failedLoginCount + 1;
  let lockedUntil = user.lockedUntil;
  if (failed >= MAX_FAILED_ATTEMPTS) {
    // 15 min after 5 failures, doubling for every further 5, capped at a day.
    const steps = Math.floor((failed - MAX_FAILED_ATTEMPTS) / MAX_FAILED_ATTEMPTS);
    lockedUntil = new Date(ctx.now() + Math.min(BASE_LOCKOUT_MS * 2 ** steps, MAX_LOCKOUT_MS));
  }
  ctx.db
    .update(users)
    .set({ failedLoginCount: failed, lockedUntil })
    .where(eq(users.id, user.id))
    .run();
}

export function clearFailedAttempts(ctx: AppContext, user: UserRow): void {
  if (user.failedLoginCount === 0 && !user.lockedUntil) return;
  ctx.db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null })
    .where(eq(users.id, user.id))
    .run();
}

/**
 * Check a password with lockout bookkeeping and constant-ish timing: unknown,
 * disabled and locked-out accounts still run a full scrypt verification.
 */
export async function checkPassword(
  ctx: AppContext,
  user: UserRow | undefined,
  password: string,
): Promise<boolean> {
  const usable = canAttemptPassword(user, ctx.now());
  const ok = await ctx.hasher.verify(password, usable ? user.passwordHash : null);
  if (!usable) return false;
  if (!ok) {
    recordFailedAttempt(ctx, user);
    return false;
  }
  clearFailedAttempts(ctx, user);
  if (user.passwordHash && ctx.hasher.needsRehash(user.passwordHash)) {
    const passwordHash = await ctx.hasher.hash(password);
    ctx.db.update(users).set({ passwordHash }).where(eq(users.id, user.id)).run();
  }
  return true;
}
