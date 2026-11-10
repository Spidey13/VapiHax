import type { CaseState, Fact, FactOrigin } from './types.js';
import { seedFacts } from './fixture.js';

export function newCaseState(sessionId: string, epoch: number, now: number): CaseState {
  return {
    sessionId,
    epoch,
    revision: 0,
    facts: seedFacts(now),
    attempts: [],
    currentCheck: null,
    notices: [],
    hypothetical: null,
    outcome: 'next-check',
    lastActivity: now,
    pendingQuestion: null,
  };
}

export interface SetFactResult {
  changed: boolean;
  disputed: boolean;
}

export interface SetFactOpts {
  sourceText?: string;
  now?: number;
}

function ensureFact(state: CaseState, path: string, now: number): Fact {
  let f = state.facts[path];
  if (!f) {
    f = { path, value: null, version: 0, status: 'unknown', origin: 'fixture', updatedAt: now };
    state.facts[path] = f;
  }
  return f;
}

/**
 * Set a fact. Field versions are monotonic and never reused (ios -> android -> ios yields v3).
 * Setting an identical value on a settled fact is a no-op.
 * An explicit typed confirmed value is never silently overwritten by a user-report: the fact becomes
 * `disputed`, the value stays, and a conflict notice is recorded until resolveConflict().
 */
export function setFact(
  state: CaseState,
  path: string,
  value: string | null,
  origin: FactOrigin,
  opts: SetFactOpts = {},
): SetFactResult {
  const now = opts.now ?? Date.now();
  const f = ensureFact(state, path, now);

  if (origin === 'user-report' && value !== null && f.origin === 'typed' && f.status === 'confirmed' && f.value !== value) {
    f.status = 'disputed';
    f.proposed = value;
    f.version += 1; // invalidates in-flight replies that depended on the old settled value
    f.updatedAt = now;
    state.revision += 1;
    state.notices.push({
      at: now,
      kind: 'conflict',
      text: `You typed ${path} = "${f.value}" but just said "${value}". Which should I use?`,
    });
    return { changed: false, disputed: true };
  }

  const nextStatus = value === null ? 'unknown' : 'confirmed';
  if (f.value === value && f.status === nextStatus) return { changed: false, disputed: false };

  f.value = value;
  f.status = nextStatus;
  f.origin = origin;
  f.sourceText = opts.sourceText;
  f.proposed = undefined;
  f.version += 1;
  f.updatedAt = now;
  state.revision += 1;
  return { changed: true, disputed: false };
}

/** keep = retain the typed value; replace = adopt the proposed (spoken) value. */
export function resolveConflict(state: CaseState, path: string, choice: 'keep' | 'replace', now = Date.now()): boolean {
  const f = state.facts[path];
  if (!f || f.status !== 'disputed') return false;
  if (choice === 'replace' && f.proposed !== undefined) {
    f.value = f.proposed;
    f.origin = 'user-report';
  }
  f.proposed = undefined;
  f.status = 'confirmed';
  f.version += 1;
  f.updatedAt = now;
  state.revision += 1;
  return true;
}

/** Value of a fact only if confirmed; otherwise null. */
export function factValue(state: CaseState, path: string): string | null {
  const f = state.facts[path];
  return f && f.status === 'confirmed' ? f.value : null;
}

export function snapshotFacts(state: CaseState, paths: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of paths) out[p] = state.facts[p]?.value ?? null;
  return out;
}
