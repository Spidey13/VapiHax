import type { Attempt, AttemptOutcome, CaseState } from './types.js';
import { getCheck } from '../rules/checks.js';
import { snapshotFacts } from './facts.js';

/** Append an attempt (history is never deleted). */
export function recordAttempt(state: CaseState, checkId: string, outcome: AttemptOutcome, now = Date.now(), note?: string): Attempt {
  const check = getCheck(checkId);
  const attempt: Attempt = {
    id: `a${state.attempts.length + 1}`,
    checkId,
    outcome,
    at: now,
    factSnapshot: snapshotFacts(state, check?.dependsOn ?? []),
    applicable: true,
    note,
  };
  state.attempts.push(attempt);
  state.revision += 1;
  return attempt;
}

/**
 * After facts change, mark attempts whose snapshotted dependency values no longer match as
 * not applicable. They stay in the list. Returns the attempts newly marked.
 */
export function supersedeAttempts(state: CaseState, changedPaths: string[]): Attempt[] {
  const marked: Attempt[] = [];
  for (const a of state.attempts) {
    if (!a.applicable) continue;
    const hit = changedPaths.some((p) => p in a.factSnapshot && a.factSnapshot[p] !== (state.facts[p]?.value ?? null));
    if (hit) {
      a.applicable = false;
      marked.push(a);
    }
  }
  if (marked.length) state.revision += 1;
  return marked;
}
