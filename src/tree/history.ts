import { getBranch, pathTurns } from './tree.js';
import type { Branch, Session, Turn } from './types.js';

export interface EffectiveHistory {
  turns: Turn[];
  notes: string[];
}

/**
 * Everything a branch's thread actually rests on: its ancestry through fork points (never siblings), without
 * scratched or blank turns, plus the notes that travel with it: one per correction turn, then the digests of every
 * merge on the parent chain (oldest ancestor first), so a corrected merge still knows its sources.
 */
export function effectiveHistory(s: Session, branchId: string): EffectiveHistory {
  const turns = pathTurns(s, branchId).filter((t) => !t.scratched && t.text.trim() !== '');
  const corrections = turns
    .filter((t) => t.kind === 'correction')
    .map((t) => `The user corrected something earlier: "${t.text}". Treat the corrected version as current.`);
  return { turns, notes: corrections.concat(inheritedMergeDigests(s, branchId)) };
}

/**
 * Drops compare and recap exchanges (the assistant's compare/recap reply and the user turn that asked for it). They
 * talk about other threads, so a digest or the notes reading them as this thread's content would misattribute them
 * (a city thread "mentioning Hokkaido"). Reply context keeps them; only digests and notes use this.
 */
export function withoutMetaExchanges(turns: Turn[]): Turn[] {
  const drop = new Set<string>();
  turns.forEach((t, i) => {
    if (t.role !== 'assistant' || (t.kind !== 'compare' && t.kind !== 'recap')) return;
    drop.add(t.id);
    const asked = turns[i - 1];
    if (asked && asked.role === 'user' && asked.branchId === t.branchId) drop.add(asked.id);
  });
  return turns.filter((t) => !drop.has(t.id));
}

/** The merge digests of every branch on the parent chain (the branch itself included), oldest ancestor first. */
export function inheritedMergeDigests(s: Session, branchId: string): string[] {
  const chain: string[][] = [];
  const seen = new Set<string>();
  for (let b = getBranch(s, branchId); b && !seen.has(b.id); b = b.parentId ? getBranch(s, b.parentId) : undefined) {
    seen.add(b.id);
    if (b.mergedFrom) chain.unshift(b.mergeDigests ?? []);
  }
  return chain.flat();
}

const isLive = (t: Turn) => !t.scratched && t.text.trim() !== '';

export interface LogicalThread {
  /** The representative: the latest valid correction copy of the topic, or the branch itself. */
  branch: Branch;
  /** The topic's own live turns (a fork does not repeat its parent's content). */
  turns: Turn[];
  notes: string[];
}

interface Topic {
  rep: Branch;
  members: Branch[];
}

/** Groups branches into topics. A correction continues its parent's topic; names never decide grouping. */
function topics(s: Session): Topic[] {
  const all = Object.values(s.branches);
  const order = new Map(all.map((b, i) => [b.id, i]));
  const byCreated = (a: Branch, b: Branch) => a.createdAt - b.createdAt || order.get(a.id)! - order.get(b.id)!;
  const own = (id: string) => s.turns.filter((t) => t.branchId === id && isLive(t));
  const chosen = new Map<string, string>(); // parent -> the correction child that continues it
  const alias = new Map<string, string>(); // a losing sibling correction -> the chosen one
  for (const p of all) {
    const pOwn = own(p.id);
    const qualifying = all
      .filter((c) => {
        if (c.origin !== 'correction' || c.parentId !== p.id || !own(c.id).some((t) => t.role === 'user')) return false;
        const ids = new Set(pathTurns(s, c.id).map((t) => t.id));
        return pOwn.every((t) => ids.has(t.id));
      })
      .sort(byCreated);
    if (!qualifying.length) continue;
    const last = qualifying[qualifying.length - 1]!;
    chosen.set(p.id, last.id);
    for (const c of qualifying) if (c !== last) alias.set(c.id, last.id);
  }
  const resolve = (id: string): string => {
    const seen = new Set<string>();
    let cur = alias.get(id) ?? id;
    while (!seen.has(cur)) {
      seen.add(cur);
      const next = chosen.get(cur);
      if (!next) break;
      cur = next;
    }
    return cur;
  };
  const groups = new Map<string, Branch[]>();
  for (const b of all) {
    const rep = resolve(b.id);
    groups.set(rep, [...(groups.get(rep) ?? []), b]);
  }
  return [...groups.entries()].map(([rep, members]) => ({ rep: s.branches[rep]!, members }));
}

/**
 * The topics of the conversation, in order of first member's creation. Only topics with a live user turn are listed.
 */
export function logicalThreads(s: Session): LogicalThread[] {
  const out: LogicalThread[] = [];
  for (const { rep, members } of topics(s)) {
    const ids = new Set(members.map((m) => m.id));
    const turns = pathTurns(s, rep.id).filter((t) => ids.has(t.branchId) && isLive(t));
    if (!turns.some((t) => t.role === 'user')) continue;
    const notes: string[] = [];
    for (const m of members) {
      notes.push(...(m.mergeDigests ?? []));
      if (m.mergedFrom) {
        const [a, b] = m.mergedFrom.map((id) => getBranch(s, id)?.name);
        if (a && b) notes.push(`Combined from "${a}" and "${b}".`);
      }
    }
    out.push({ branch: rep, turns, notes });
  }
  return out;
}

/** Every branch that belongs to a listed topic (representatives and absorbed correction ancestors). */
export function topicMemberIds(s: Session): Set<string> {
  const listed = new Set(logicalThreads(s).map((t) => t.branch.id));
  const ids = new Set<string>();
  for (const { rep, members } of topics(s)) if (listed.has(rep.id)) for (const m of members) ids.add(m.id);
  return ids;
}
