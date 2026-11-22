import { and, eq, ne } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { AppDatabase } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';
import { parseCookies, serializeCookie } from '../http/cookies.ts';
import { randomToken, sha256 } from './tokens.ts';

export type SessionRow = typeof sessions.$inferSelect;
export type UserRow = typeof users.$inferSelect;

/** Sliding expiry: a session survives 30 days without use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Step-up re-auth: a credential check within this window counts as recent. */
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;
/**
 * For the 즉시 lock setting the client locks the session when the app is
 * hidden; this server-side backstop also locks after a minute without requests
 * in case that signal is lost (e.g. the app was killed).
 */
export const IMMEDIATE_LOCK_BACKSTOP_MS = 60 * 1000;

export interface ResolvedSession {
  token: string;
  session: SessionRow;
  user: UserRow;
  locked: boolean;
}

/** Inactivity allowed before the session locks, or null when the lock is off. */
export function lockAfterMs(user: Pick<UserRow, 'lockTimeoutSeconds'>): number | null {
  const seconds = user.lockTimeoutSeconds;
  if (seconds === null || seconds === undefined) return null;
  return seconds === 0 ? IMMEDIATE_LOCK_BACKSTOP_MS : seconds * 1000;
}

export class SessionService {
  readonly cookieName: string;
  private readonly secure: boolean;
  private readonly db: AppDatabase;
  private readonly now: () => number;

  constructor(db: AppDatabase, publicOrigin: string, now: () => number) {
    this.db = db;
    this.now = now;
    // `__Host-` requires Secure, so it is only usable over https. Plain
    // http://localhost development falls back to a normal host-only cookie.
    this.secure = publicOrigin.startsWith('https://');
    this.cookieName = this.secure ? '__Host-budget_session' : 'budget_session';
  }

  create(userId: number, meta: { userAgent?: string; ip?: string }): { token: string } {
    const token = randomToken(32);
    const now = new Date(this.now());
    this.db
      .insert(sessions)
      .values({
        id: sha256(token),
        userId,
        createdAt: now,
        lastSeenAt: now,
        lastVerifiedAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        lastIp: meta.ip ?? null,
      })
      .run();
    return { token };
  }

  /** Look up the session for a cookie token. Expired sessions are deleted. */
  resolve(token: string): ResolvedSession | null {
    const id = sha256(token);
    const row = this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, id))
      .get();
    if (!row) return null;
    const now = this.now();
    if (row.session.expiresAt.getTime() <= now || row.user.disabledAt) {
      this.revoke(id);
      return null;
    }
    let locked = row.session.lockedAt !== null;
    const limit = lockAfterMs(row.user);
    if (!locked && limit !== null && now - row.session.lastSeenAt.getTime() > limit) {
      locked = true;
      const lockedAt = new Date(now);
      this.db.update(sessions).set({ lockedAt }).where(eq(sessions.id, id)).run();
      row.session.lockedAt = lockedAt;
    }
    return { token, session: row.session, user: row.user, locked };
  }

  /** Record activity on an unlocked session and slide its expiry. */
  touch(session: SessionRow, ip: string | undefined): void {
    const now = new Date(this.now());
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    this.db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt, lastIp: ip ?? session.lastIp })
      .where(eq(sessions.id, session.id))
      .run();
    session.lastSeenAt = now;
    session.expiresAt = expiresAt;
  }

  lock(sessionId: string): void {
    this.db
      .update(sessions)
      .set({ lockedAt: new Date(this.now()) })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  /** A successful passkey/password check: unlocks and opens the re-auth window. */
  markVerified(sessionId: string): void {
    const now = new Date(this.now());
    this.db
      .update(sessions)
      .set({ lockedAt: null, lastVerifiedAt: now, lastSeenAt: now })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  isRecentlyVerified(session: SessionRow): boolean {
    const at = session.lastVerifiedAt?.getTime();
    return at !== undefined && this.now() - at <= REAUTH_WINDOW_MS;
  }

  revoke(sessionId: string): void {
    this.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }

  revokeAllForUser(userId: number, exceptSessionId?: string): number {
    const where = exceptSessionId
      ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
      : eq(sessions.userId, userId);
    return this.db.delete(sessions).where(where).run().changes;
  }

  listForUser(userId: number): SessionRow[] {
    return this.db.select().from(sessions).where(eq(sessions.userId, userId)).all();
  }

  tokenFromCookieHeader(header: string | undefined): string | null {
    return parseCookies(header).get(this.cookieName) ?? null;
  }

  setCookie(reply: FastifyReply, token: string): void {
    reply.header(
      'set-cookie',
      serializeCookie(this.cookieName, token, {
        maxAgeSeconds: SESSION_TTL_MS / 1000,
        secure: this.secure,
      }),
    );
  }

  clearCookie(reply: FastifyReply): void {
    reply.header(
      'set-cookie',
      serializeCookie(this.cookieName, '', { maxAgeSeconds: 0, secure: this.secure }),
    );
  }
}
