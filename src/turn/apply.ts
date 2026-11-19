import type { Branch, Session, Turn } from '../tree/types.js';
import {
  forkBranch, getBranch, liveCount, mergeBranches, NEW_NAME, park, pathTurns, renameBranch, scratchLast, setStatus, switchTo,
} from '../tree/tree.js';
import type { RouteDecision } from '../route/types.js';
import { FORK_ACK, NOTHING_TO_SCRATCH, NOTHING_YET, ONLY_ONE_THREAD, PARKED, SCRATCHED, SET_ASIDE, switchConfirm } from '../reply/copy.js';
import {
  askMergeInstruction, askWhichInstruction, compareInstruction, mergeOpeningInstruction, parkedReminderInstruction, recapInstruction, setAsideInstruction, switchFollowInstruction,
} from '../reply/prompts.js';

export interface Applied {
  branchId: string;
  prefix: string | null;
  instruction: string | null;
  kind?: 'correction';
  /** Marks the assistant turn: merge opening, recap or compare. */
  replyKind?: Turn['kind'];
  forked: boolean;
  /** The prefix is the whole reply: record it as the assistant turn and do not call the responder. */
  skipReply?: boolean;
  /** Names of the two merged sources: the new branch needs a name. */
  merged?: [string, string];
  /** A scratch command: its own user and assistant turns are recorded already scratched. */
  scratchCommand?: boolean;
  /** Branches whose digest the reply needs (compare: the other branch; merge: both sources). */
  digestOf?: { id: string; name: string }[];
}

/** At most three live (live + provisional) branches at once. */
export const MAX_LIVE = 3;
/** Consecutive `continue` turns on a parent before a parked child is offered back. */
const OFFER_BACK_AFTER = 3;
/** Names at most this many threads in a recap. */
const RECAP_MAX = 3;

const join = (...parts: (string | null | undefined)[]): string | null => {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length ? kept.join(' ') : null;
};

const YES = /^(yes|yeah|yep|sure|ok(ay)?|please|go ahead|do it|let'?s do it|combine them|sounds good)\b/i;
/** A short affirmative: at most six words, opening with a yes-like phrase. */
export function isPlainYes(text: string): boolean {
  const t = text.trim().replace(/^[^\w]+|[^\w]+$/g, '');
  return t.split(/\s+/).length <= 6 && YES.test(t);
}

const pairKey = (a: string, b: string): string => [a, b].sort().join('|');

function lastLine(s: Session, id: string): string {
  const own = pathTurns(s, id).filter((t) => !t.scratched && t.text.trim() !== '');
  const user = [...own].reverse().find((t) => t.role === 'user');
  return (user ?? own[own.length - 1])?.text ?? '';
}

/** A branch still called "New path" is named by its own last user line (about six words). */
function setAsideName(s: Session, b: Branch): string {
  if (b.name !== NEW_NAME) return b.name;
  const own = s.turns.filter((t) => t.branchId === b.id && t.role === 'user' && !t.scratched && t.text.trim() !== '');
  const text = own.at(-1)?.text.trim();
  return text ? text.split(/\s+/).slice(0, 6).join(' ') : b.name;
}

/** Parks the least recently active live branches (not the protected ones) until at most three are live. Returns their names, in order. */
export function enforceLiveLimit(s: Session, protect: string[], now: number): string[] {
  const names: string[] = [];
  while (liveCount(s) > MAX_LIVE) {
    const victim = Object.values(s.branches)
      .filter((b) => b.status === 'live' && !protect.includes(b.id))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
    if (!victim) break;
    setStatus(s, victim.id, 'parked', now);
    names.push(victim.name);
  }
  return names;
}

/** Tap or voice switch with the live limit applied. Returns the names of any branches set aside. */
export function switchWithLimit(s: Session, targetId: string, now: number): { ok: boolean; setAside: string[] } {
  const left = s.currentBranchId;
  const target = getBranch(s, targetId);
  // Only reviving a parked or faded branch adds a live one.
  const adds = !!target && (target.status === 'parked' || target.status === 'faded');
  if (!switchTo(s, targetId, now)) return { ok: false, setAside: [] };
  return { ok: true, setAside: adds && left !== targetId ? enforceLiveLimit(s, [left, targetId], now) : [] };
}

/** Drops the pending set-aside question once its branch is no longer the provisional current one. */
function settleAwaiting(s: Session): void {
  const a = s.awaitingSetAside;
  if (!a) return;
  const b = getBranch(s, a.branchId);
  if (!b || b.status !== 'provisional' || s.currentBranchId !== a.branchId) delete s.awaitingSetAside;
}

export function applyDecision(s: Session, d: RouteDecision, now: number, utterance = ''): Applied {
  settleAwaiting(s);
  const before = s.branches[s.currentBranchId];
  const awaiting = s.awaitingSetAside;
  // Offers and questions from the previous turn last one turn.
  const pending = { offer: s.pendingMergeOffer, merge: s.pendingMerge };
  delete s.pendingMergeOffer;
  delete s.pendingMerge;
  // A nudge already given once is not repeated: the second unanswered turn just records it.
  if (awaiting && awaiting.asked < 2) awaiting.asked = 2;

  const { applied, plain } = applyOp(s, d, now, awaiting ?? undefined, pending, utterance);
  settleAwaiting(s);

  // Streaks: any non-continue op resets the branch it started on and the branch it ended on.
  if (!plain) {
    before.continueStreak = 0;
    const after = getBranch(s, applied.branchId);
    if (after) after.continueStreak = 0;
    return applied;
  }
  const cur = s.branches[applied.branchId];
  cur.continueStreak = (cur.continueStreak ?? 0) + 1;
  if (cur.continueStreak >= OFFER_BACK_AFTER) {
    const parked = Object.values(s.branches)
      .filter((b: Branch) => b.parentId === cur.id && b.status === 'parked' && !b.offeredBack)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (parked) {
      parked.offeredBack = true;
      applied.instruction = join(applied.instruction, parkedReminderInstruction(parked.name));
    }
  }
  return applied;
}

function applyOp(
  s: Session,
  d: RouteDecision,
  now: number,
  awaiting: { branchId: string; asked: number } | undefined,
  pending: { offer?: { a: string; b: string }; merge?: boolean },
  utterance: string,
): { applied: Applied; plain: boolean } {
  let op = d.op;
  let current = s.branches[s.currentBranchId];
  const stay = (): Applied => ({ branchId: s.currentBranchId, prefix: null, instruction: null, forked: false });
  const plain = (): { applied: Applied; plain: boolean } => ({ applied: stay(), plain: true });
  const done = (applied: Applied): { applied: Applied; plain: boolean } => ({ applied, plain: false });

  const doMerge = (aId: string, bId: string): { applied: Applied; plain: boolean } => {
    const a = getBranch(s, aId)!;
    const b = getBranch(s, bId)!;
    const merged = mergeBranches(s, aId, bId, now);
    return done({
      branchId: merged.id, prefix: null, instruction: mergeOpeningInstruction(a.name, b.name), forked: false,
      merged: [a.name, b.name], digestOf: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }], replyKind: 'merge-opening',
    });
  };

  // Nothing to park on the root: an ordinary reply.
  if (op.kind === 'park' && !op.targetId && !current.parentId) op = { kind: 'continue' };

  // "Which thread should I combine this with?" is answered by a confident target.
  if (pending.merge && op.kind === 'switch' && op.targetId !== current.id) {
    const t = getBranch(s, op.targetId);
    if (t && t.status !== 'faded') op = { kind: 'merge', otherId: t.id };
  }

  // A merge offer made by the last compare is accepted ("yes, combine them", "sure, do it").
  if (pending.offer) {
    const a = getBranch(s, pending.offer.a);
    const b = getBranch(s, pending.offer.b);
    // Accepted by a merge op, or by a plain continue/fork answered with a short "yes".
    const accepts = op.kind === 'ask-merge'
      || (op.kind === 'merge' && (op.otherId === pending.offer.a || op.otherId === pending.offer.b))
      || ((op.kind === 'fork' || op.kind === 'continue') && isPlainYes(utterance));
    if (accepts && a && b && a.id !== b.id && a.status !== 'faded' && b.status !== 'faded') return doMerge(a.id, b.id);
  }

  // A confident target answers the set-aside question: park it and keep the new branch.
  // A switch to the new branch's parent instead drops the new idea (handled below).
  const answer: string | undefined =
    op.kind === 'switch' && op.targetId !== current.parentId ? op.targetId : op.kind === 'park' ? op.targetId : undefined;
  if (awaiting && answer && answer !== current.id) {
    const target = getBranch(s, answer);
    if (target && target.status === 'live') {
      setStatus(s, target.id, 'parked', now);
      setStatus(s, current.id, 'live', now);
      delete s.awaitingSetAside;
      return done({ branchId: current.id, prefix: PARKED, instruction: null, forked: false });
    }
  }

  // Without a pending question, a park naming another live branch sets that one aside and stays here.
  if (op.kind === 'park' && op.targetId && op.targetId !== current.id) {
    const t = getBranch(s, op.targetId);
    if (t && t.status === 'live' && t.parentId) {
      setStatus(s, t.id, 'parked', now);
      return done({ branchId: current.id, prefix: PARKED, instruction: null, forked: false });
    }
  }

  if (current.status === 'provisional') {
    const parentId = current.parentId;
    if (op.kind === 'continue' || op.kind === 'correct') {
      // While the set-aside question is open the new branch stays provisional.
      if (!awaiting) setStatus(s, current.id, 'live', now);
    } else if (parentId && (op.kind === 'fork' || (op.kind === 'switch' && op.targetId === parentId))) {
      setStatus(s, current.id, 'faded', now);
      if (op.kind === 'fork') current = s.branches[parentId];
    }
  }

  switch (op.kind) {
    case 'fork': {
      const crowded = liveCount(s) >= MAX_LIVE;
      const names = crowded
        ? Object.values(s.branches).filter((b) => b.status === 'live' || b.status === 'provisional').map((b) => setAsideName(s, b))
        : [];
      const b = forkBranch(s, current.id, 'fork', 'provisional', now);
      if (crowded) s.awaitingSetAside = { branchId: b.id, asked: 1 };
      return done({
        branchId: b.id,
        prefix: op.acknowledge ? FORK_ACK : null,
        instruction: crowded ? setAsideInstruction(names) : null,
        forked: true,
      });
    }
    case 'correct': {
      // While the set-aside question is open the correction stays provisional and carries the question.
      const b = forkBranch(s, current.id, 'correction', awaiting ? 'provisional' : 'live', now);
      renameBranch(s, b.id, current.name);
      setStatus(s, current.id, 'faded', now);
      if (awaiting) s.awaitingSetAside = { branchId: b.id, asked: 2 };
      return done({ branchId: b.id, prefix: null, instruction: null, kind: 'correction', forked: false });
    }
    case 'switch': {
      const sw = switchWithLimit(s, op.targetId, now);
      if (!sw.ok) break;
      return done({ branchId: op.targetId, prefix: join(...sw.setAside.map(SET_ASIDE), switchConfirm(s.branches[op.targetId].name)), instruction: switchFollowInstruction(switchConfirm(s.branches[op.targetId].name)), forked: false });
    }
    case 'ask-which': {
      const names = Object.values(s.branches)
        .filter((b) => b.id !== current.id && b.status !== 'faded')
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .map((b) => b.name);
      if (!names.length) break;
      return done({ branchId: current.id, prefix: null, instruction: askWhichInstruction(names), forked: false });
    }
    case 'ask-merge': {
      const names = Object.values(s.branches)
        .filter((b) => b.id !== current.id && b.status !== 'faded')
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .map((b) => b.name);
      if (!names.length) break;
      s.pendingMerge = true;
      return done({ branchId: current.id, prefix: null, instruction: askMergeInstruction(names), forked: false });
    }
    case 'park': {
      if (!current.parentId) break;
      const parentId = park(s, current.id, now);
      return done({ branchId: parentId, prefix: PARKED, instruction: null, forked: false });
    }
    case 'scratch': {
      const did = scratchLast(s, current.id);
      let branchId = current.id;
      // The scratched utterance created this branch and nothing else is left on it: drop it and step back.
      // A correction's parent is faded by the correction itself and is revived; a fork steps back only to a live parent.
      const parent = current.parentId ? getBranch(s, current.parentId) : undefined;
      if (did && parent && (current.origin === 'correction' || (current.origin === 'fork' && parent.status !== 'faded'))
        && !s.turns.some((t) => t.branchId === current.id && !t.scratched)) {
        setStatus(s, current.id, 'faded', now);
        branchId = parent.id;
        switchTo(s, branchId, now);
      }
      return done({ branchId, prefix: did ? SCRATCHED : NOTHING_TO_SCRATCH, instruction: null, forked: false, skipReply: true, scratchCommand: true });
    }
    case 'only-one-thread':
      return done({ branchId: current.id, prefix: ONLY_ONE_THREAD, instruction: null, forked: false, skipReply: true });
    case 'recap': {
      if (!s.turns.some((t) => t.role === 'user' && !t.scratched)) {
        return done({ branchId: current.id, prefix: NOTHING_YET, instruction: null, forked: false, skipReply: true });
      }
      const items = Object.values(s.branches)
        .filter((b) => b.status !== 'faded')
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, RECAP_MAX)
        .map((b) => ({ name: b.name, lastLine: lastLine(s, b.id) }));
      if (!items.length) break;
      return done({ branchId: current.id, prefix: null, instruction: recapInstruction(items), forked: false, replyKind: 'recap' });
    }
    case 'compare': {
      const other = op.otherId ? getBranch(s, op.otherId) : undefined;
      if (!other || other.id === current.id) break;
      const key = pairKey(current.id, other.id);
      const offerMerge = !(current.mergeOffered ?? []).includes(key);
      if (offerMerge) {
        current.mergeOffered = [...(current.mergeOffered ?? []), key];
        other.mergeOffered = [...(other.mergeOffered ?? []), key];
        s.pendingMergeOffer = { a: current.id, b: other.id };
      }
      return done({ branchId: current.id, prefix: null, instruction: compareInstruction(other.name, offerMerge), forked: false, digestOf: [{ id: other.id, name: other.name }], replyKind: 'compare' });
    }
    case 'merge': {
      const other = getBranch(s, op.otherId);
      if (!other || other.id === current.id) break;
      return doMerge(current.id, other.id);
    }
    case 'continue':
      break;
    default: {
      const unreachable: never = op;
      void unreachable;
    }
  }
  return plain();
}
