import { randomToken } from './tokens.ts';

export type ChallengePurpose = 'register' | 'login' | 'verify';

export interface StoredChallenge {
  challenge: string;
  purpose: ChallengePurpose;
  /** Bound user for register/verify; null for discoverable login. */
  userId: number | null;
  /** Bound session for register/verify. */
  sessionId: string | null;
  expiresAt: number;
}

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 1000;

/** Server-side WebAuthn challenges: single use, short-lived, bound to a purpose. */
export class ChallengeStore {
  private readonly items = new Map<string, StoredChallenge>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  create(entry: Omit<StoredChallenge, 'expiresAt'>): { challengeId: string } {
    const now = this.now();
    for (const [id, item] of this.items) if (item.expiresAt <= now) this.items.delete(id);
    if (this.items.size >= MAX_CHALLENGES) {
      // Drop the oldest entry; Map preserves insertion order.
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    const challengeId = randomToken(18);
    this.items.set(challengeId, { ...entry, expiresAt: now + CHALLENGE_TTL_MS });
    return { challengeId };
  }

  /** Remove and return the challenge if it exists, is unexpired and matches the purpose. */
  consume(challengeId: string, purpose: ChallengePurpose): StoredChallenge | null {
    const item = this.items.get(challengeId);
    this.items.delete(challengeId);
    if (!item || item.purpose !== purpose || item.expiresAt <= this.now()) return null;
    return item;
  }
}
