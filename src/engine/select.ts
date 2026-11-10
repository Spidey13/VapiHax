import type { CaseState, Check, DependencyStamp } from '../case/types.js';
import { CHECKS } from '../rules/checks.js';

export type Selection =
  | { kind: 'check'; check: Check; stamp: DependencyStamp }
  | { kind: 'unsupported'; check: Check; stamp: DependencyStamp }
  | { kind: 'clarify'; question: 'phone.platform' | 'phone.googleServices' | 'conflict'; paths: string[] }
  | { kind: 'handoff' }
  | { kind: 'unresolved' };

export function stampFor(state: CaseState, paths: string[], checkId?: string): DependencyStamp {
  const fieldVersions: Record<string, number> = {};
  for (const p of paths) fieldVersions[p] = state.facts[p]?.version ?? 0;
  return { sessionId: state.sessionId, epoch: state.epoch, fieldVersions, checkId };
}

function matches(state: CaseState, path: string, want: string | string[]): boolean {
  const f = state.facts[path];
  const wants = Array.isArray(want) ? want : [want];
  if (f?.status === 'disputed') return false; // withhold dependent advice until resolved
  for (const w of wants) {
    if (w === 'unknown') {
      if (!f || f.value === null || f.status !== 'confirmed') return true;
    } else if (f && f.status === 'confirmed' && f.value === w) {
      return true;
    }
  }
  return false;
}

export function isEligible(state: CaseState, check: Check): boolean {
  return Object.entries(check.requires).every(([path, want]) => matches(state, path, want));
}

/** Distinct check ids with an applicable failed attempt. */
export function failedCheckIds(state: CaseState): string[] {
  return [...new Set(state.attempts.filter((a) => a.applicable && a.outcome === 'failed').map((a) => a.checkId))];
}

function alreadyDealtWith(state: CaseState, checkId: string): boolean {
  return state.attempts.some(
    (a) => a.applicable && a.checkId === checkId && (a.outcome === 'failed' || a.outcome === 'succeeded' || a.outcome === 'skipped'),
  );
}

/** Pure: decides what the next reply should be about, without mutating state. */
export function selectNext(state: CaseState): Selection {
  // 1. Unresolved typed-vs-voice conflicts withhold everything that depends on them.
  const disputed = Object.values(state.facts).filter((f) => f.status === 'disputed');
  if (disputed.length) return { kind: 'clarify', question: 'conflict', paths: disputed.map((f) => f.path) };

  // 2. A documented capability blocker outranks everything else.
  for (const c of CHECKS) {
    if (c.terminal === 'unsupported' && isEligible(state, c)) {
      return { kind: 'unsupported', check: c, stamp: stampFor(state, c.dependsOn, c.id) };
    }
  }

  // 3. Stop after two distinct failed checks.
  if (failedCheckIds(state).length >= 2) return { kind: 'handoff' };

  // 4. Android needs Google services confirmed before the Android sync path; never assume it.
  const platform = state.facts['phone.platform'];
  const gs = state.facts['phone.googleServices'];
  const sync = state.facts['sync.status'];
  const syncOpen = !sync || sync.value === null || sync.value === 'not-done';
  if (platform?.value === 'android' && platform.status === 'confirmed' && (!gs || gs.value === null) && syncOpen) {
    return { kind: 'clarify', question: 'phone.googleServices', paths: ['phone.platform', 'phone.googleServices'] };
  }

  // 5. First eligible, not-yet-dealt-with check in curated order.
  for (const c of CHECKS) {
    if (c.terminal) continue;
    if (alreadyDealtWith(state, c.id)) continue;
    if (isEligible(state, c)) return { kind: 'check', check: c, stamp: stampFor(state, c.dependsOn, c.id) };
  }

  // 6. Nothing eligible: ask for the phone if we do not know it yet, else stop honestly.
  if (!platform || platform.value === null) {
    return { kind: 'clarify', question: 'phone.platform', paths: ['phone.platform'] };
  }
  return { kind: 'unresolved' };
}
