/**
 * Who may see what (DESIGN 5): members keep separate ledgers — each sees only
 * their own transactions, cards and accounts, budgets and 고정지출. An admin
 * sees everyone's (transactions via `visibleTo` in queries.ts).
 */
import { eq, or, type SQL } from 'drizzle-orm';
import type { UserRole } from '@budget/shared';
import { accounts } from '../db/schema.ts';
import { errors } from '../http/errors.ts';

export interface Viewer {
  id: number;
  role: UserRole;
}

export const isAdmin = (viewer: Viewer): boolean => viewer.role === 'admin';

/** Accounts a member sees and may pay with: ones they hold or actually use (family cards). */
export function canSeeAccount(
  viewer: Viewer,
  account: { ownerUserId: number; primaryUserId: number | null },
): boolean {
  return (
    isAdmin(viewer) || account.ownerUserId === viewer.id || account.primaryUserId === viewer.id
  );
}

/** SQL form of canSeeAccount; undefined (no condition) for an admin. */
export function accountVisibleTo(viewer: Viewer): SQL | undefined {
  if (isAdmin(viewer)) return undefined;
  return or(eq(accounts.ownerUserId, viewer.id), eq(accounts.primaryUserId, viewer.id));
}

/**
 * Whose budgets, 고정지출 or statistics `viewer` asks for: themselves unless
 * they name someone else, which only an admin may.
 */
export function targetUser(viewer: Viewer, requested: number | null | undefined): number {
  if (requested === null || requested === undefined || requested === viewer.id) return viewer.id;
  if (!isAdmin(viewer)) throw errors.forbidden("Only an admin can see another member's data");
  return requested;
}
