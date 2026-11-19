import { randomUUID } from 'node:crypto';
import type { Session } from './types.js';
import { createSession } from './tree.js';

export const IDLE_EXPIRY_MS = 30 * 60_000;
/** Ended sessions (and their share pages) are kept this long after ending, whatever the idle time. */
export const ENDED_KEEP_MS = 24 * 60 * 60_000;

const expired = (s: Session, t: number) => (s.ended ? t - s.ended.at > ENDED_KEEP_MS : t - s.lastActivity > IDLE_EXPIRY_MS);

export class SessionStore {
  private sessions = new Map<string, Session>();
  /** shareId -> session id, so share lookups do not scan every session. */
  private shares = new Map<string, string>();

  constructor(private now: () => number = Date.now) {}

  create(): Session {
    this.sweep();
    const s = createSession(randomUUID(), this.now());
    this.sessions.set(s.id, s);
    return s;
  }

  /** Marks a session ended and indexes its share id. */
  end(s: Session, ended: NonNullable<Session['ended']>): void {
    s.ended = ended;
    this.shares.set(ended.shareId, s.id);
  }

  private drop(id: string): void {
    const s = this.sessions.get(id);
    if (s?.ended) this.shares.delete(s.ended.shareId);
    this.sessions.delete(id);
  }

  /** Returns the session and counts the access as activity; undefined once it has been idle too long. */
  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const t = this.now();
    if (expired(s, t)) {
      this.drop(id);
      return undefined;
    }
    s.lastActivity = t;
    return s;
  }

  /** The ended session behind a share id, without counting as activity; undefined if unknown or past 24 h. */
  getByShareId(shareId: string): Session | undefined {
    const id = this.shares.get(shareId);
    const s = id === undefined ? undefined : this.sessions.get(id);
    if (!id || !s) return undefined;
    if (expired(s, this.now())) {
      this.drop(id);
      return undefined;
    }
    return s;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (expired(s, t)) this.drop(id);
  }
}
