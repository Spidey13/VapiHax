import { randomUUID } from 'node:crypto';
import type { CaseState, DependencyStamp } from './types.js';
import { newCaseState } from './facts.js';

export const IDLE_EXPIRY_MS = 30 * 60 * 1000;

export class CaseStore {
  private cases = new Map<string, CaseState>();
  constructor(private now: () => number = Date.now) {}

  createCase(): CaseState {
    const id = randomUUID();
    const state = newCaseState(id, 1, this.now());
    this.cases.set(id, state);
    return state;
  }

  /** Returns undefined for unknown or idle-expired sessions. Touches lastActivity. */
  getCase(id: string): CaseState | undefined {
    const s = this.cases.get(id);
    if (!s) return undefined;
    const t = this.now();
    if (t - s.lastActivity > IDLE_EXPIRY_MS) {
      this.cases.delete(id);
      return undefined;
    }
    s.lastActivity = t;
    return s;
  }

  /** Reset in place: epoch+1, fixture reseeded, all prior stamps become stale. Same object identity is kept. */
  resetCase(id: string): CaseState | undefined {
    const s = this.getCase(id);
    if (!s) return undefined;
    const fresh = newCaseState(id, s.epoch + 1, this.now());
    Object.assign(s, fresh);
    return s;
  }

  deleteCase(id: string): void {
    this.cases.delete(id);
  }
}

/** A stamp is current iff same session + epoch and every stamped field version is unchanged. */
export function isStampCurrent(state: CaseState | undefined, stamp: DependencyStamp | null): boolean {
  if (!state || !stamp) return false;
  if (stamp.sessionId !== state.sessionId || stamp.epoch !== state.epoch) return false;
  return Object.entries(stamp.fieldVersions).every(([path, v]) => state.facts[path]?.version === v);
}
