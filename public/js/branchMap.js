// Pure model for the branch map: no DOM. The session's branches become one ordered list of rows,
// depth-first from the root, children in creation order, so it reads as one conversation splitting.

/** HSL triplets (use as `hsl(var(--h))`): mint, periwinkle, apricot, lilac, rose, sky. Same values for dots and glow. */
export const HUES = ['158 60% 64%', '226 88% 72%', '28 80% 72%', '270 70% 76%', '345 75% 78%', '195 70% 70%'];

/** Hue by creation order (array order, faded branches included so colors never shift), cycling. Unknown ids get the first hue. */
export function hueFor(branches, id) {
  // A correction is a hidden copy of the branch it corrects: it keeps that branch's hue (through a chain of them).
  const seen = new Set();
  let b = branches.find((x) => x.id === id);
  while (b && b.origin === 'correction' && b.parentId != null && !seen.has(b.id)) {
    seen.add(b.id);
    const p = branches.find((x) => x.id === b.parentId);
    if (!p) break;
    b = p;
    id = p.id;
  }
  const i = branches.findIndex((x) => x.id === id);
  return HUES[(i < 0 ? 0 : i) % HUES.length];
}

/**
 * @param {Array<{id:string,name:string,status:string,parentId?:string|null,mergedFrom?:string[]}>} branches array order = creation order
 * @param {string} currentId
 * @param {{ keepMerged?: boolean }} [o] keepMerged (end screen): faded merge sources stay as dimmed rows
 * @returns {Array<{ id:string, name:string, depth:number, hue:string, status:string, isCurrent:boolean, faded:boolean,
 *   parked:boolean, provisional:boolean, merged:boolean, parentId:string|null }>}
 *   Faded branches are not rows. A child of a faded branch hangs from its nearest visible ancestor.
 *   A merged branch is one row (merged: true); its sources are faded, so only it shows.
 */
export function mapRows(branches, currentId, { keepMerged = false } = {}) {
  if (!branches?.length) return [];
  const byId = new Map(branches.map((b) => [b.id, b]));
  const sources = new Set(keepMerged ? branches.flatMap((b) => b.mergedFrom ?? []) : []);
  const shown = (b) => b.status !== 'faded' || b.id === currentId || sources.has(b.id);
  const visibleParent = (b) => {
    const seen = new Set([b.id]);
    let p = b.parentId != null ? byId.get(b.parentId) : undefined;
    while (p && !seen.has(p.id)) {
      if (shown(p)) return p.id;
      seen.add(p.id);
      p = p.parentId != null ? byId.get(p.parentId) : undefined;
    }
    return null;
  };
  const kids = new Map(); // parent id (or null) -> children in creation order
  for (const b of branches) {
    if (!shown(b)) continue;
    const p = visibleParent(b);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(b);
  }
  const rows = [];
  const walk = (parent, depth) => {
    for (const b of kids.get(parent) ?? []) {
      rows.push({
        id: b.id,
        name: b.name,
        depth,
        hue: hueFor(branches, b.id),
        status: b.status,
        isCurrent: b.id === currentId,
        faded: b.status === 'faded' && b.id !== currentId,
        parked: b.status === 'parked',
        provisional: b.status === 'provisional',
        merged: (b.mergedFrom?.length ?? 0) > 0,
        parentId: parent,
      });
      walk(b.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** The media query for the phone layout: narrow screens and coarse pointers (the desktop UI is untouched by it). */
export const PHONE_QUERY = '(max-width: 600px), (pointer: coarse)';

/**
 * The compact map for phones: when there are more than `max` rows, keep only the current branch and its
 * parent, re-based so the shallowest kept row sits at depth 0 and nothing hangs from a branch that is not shown.
 * @param {ReturnType<typeof mapRows>} rows
 * @param {number} [max]
 * @returns {{ rows: ReturnType<typeof mapRows>, more: number }} `more` = how many rows were left out
 */
export function compactRows(rows, max = 3) {
  if (rows.length <= max) return { rows, more: 0 };
  const cur = rows.find((r) => r.isCurrent) ?? rows[0];
  const keep = new Set([cur.id]);
  if (cur.parentId != null && rows.some((r) => r.id === cur.parentId)) keep.add(cur.parentId);
  const kept = rows.filter((r) => keep.has(r.id));
  const base = Math.min(...kept.map((r) => r.depth));
  return {
    rows: kept.map((r) => ({ ...r, depth: r.depth - base, parentId: r.parentId != null && keep.has(r.parentId) ? r.parentId : null })),
    more: rows.length - kept.length,
  };
}
