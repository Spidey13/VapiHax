/**
 * @typedef {{ id: string, origin: string, status: string, parentId?: string, mergedFrom?: string[] }} BranchLike
 * @typedef {{ sheets: any, branches: BranchLike[], lastDecision?: any }} StateLike
 * @typedef {{ kind: 'none' | 'fork' | 'switch' | 'correction' | 'fade' | 'merge' | 'park' | 'recap' | 'compare' | 'refresh', from?: string, to?: string }} Transition
 */

/** Everything that changes layout; when this is unchanged only the transcript text updates. */
export const structureSig = (s) => {
  const sh = s.sheets ?? {};
  const c = sh.current ?? {};
  return JSON.stringify([c.id, c.name, c.status, c.originName, sh.peek, sh.others, sh.parked]);
};

/**
 * Compare two stateView-like objects and name the structural change, if any.
 * Priority when several apply: merge/park/switch/fork/correction > fade > recap/compare > refresh.
 * `refresh` is a quiet layout change (rename, provisional -> live, a new tab) the queue holds
 * back while someone is speaking.
 * @param {StateLike | null | undefined} prev
 * @param {StateLike} next
 * @returns {Transition}
 */
export function detectTransition(prev, next) {
  if (!prev) return { kind: 'none' };
  const from = prev.sheets.current.id;
  const to = next.sheets.current.id;
  const prevById = new Map(prev.branches.map((b) => [b.id, b]));
  if (from !== to) {
    const created = !prevById.has(to);
    const target = next.branches.find((b) => b.id === to);
    if (!created) {
      // Current moved to the parent of a branch that just got parked.
      const parked = next.branches.some((b) => b.status === 'parked' && b.parentId === to && prevById.get(b.id)?.status !== 'parked');
      return parked ? { kind: 'park', from, to } : { kind: 'switch', from, to };
    }
    const origin = target?.origin;
    if (origin === 'merge') return { kind: 'merge', from, to, sources: target.mergedFrom ?? [] };
    if (origin === 'fork') return { kind: 'fork', from, to };
    if (origin === 'correction') return { kind: 'correction', from, to };
    return { kind: 'switch', from, to };
  }
  const faded = next.branches.some((b) => b.status === 'faded' && prevById.get(b.id) && prevById.get(b.id).status !== 'faded');
  if (faded) return { kind: 'fade' };
  // A decision is new when its JSON differs from the one already seen (the server keeps it until the next turn).
  const op = next.lastDecision?.op;
  if (op && (op.kind === 'recap' || op.kind === 'compare') && JSON.stringify(next.lastDecision) !== JSON.stringify(prev.lastDecision ?? null)) {
    return op.kind === 'compare' ? { kind: 'compare', other: op.otherId ?? null } : { kind: 'recap' };
  }
  return structureSig(prev) !== structureSig(next) ? { kind: 'refresh' } : { kind: 'none' };
}

/** Recap and compare only inform: they change no structure, so they play at once, even while the assistant speaks. */
export function isInformational(t) {
  return t.kind === 'recap' || t.kind === 'compare';
}
