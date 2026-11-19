import type { Branch, BranchStatus, Session, Turn } from './types.js';

/** The root's name until it is named from its content (at its first fork). */
export const ROOT_NAME = 'Main';
/** A forked branch's name until the namer names it. */
export const NEW_NAME = 'New path';

export function createSession(id: string, now: number): Session {
  const root: Branch = {
    id: 'b1',
    parentId: null,
    forkAfterTurnId: null,
    name: ROOT_NAME,
    status: 'live',
    origin: 'root',
    createdAt: now,
    lastActiveAt: now,
  };
  return {
    id,
    epoch: 0,
    revision: 0,
    branches: { b1: root },
    turns: [],
    currentBranchId: 'b1',
    lastActivity: now,
    counters: { branch: 1, turn: 0 },
    hold: false,
  };
}

/** Own-property lookup so inherited keys like 'constructor' are never branches. */
export function getBranch(s: Session, id: string): Branch | undefined {
  return Object.hasOwn(s.branches, id) ? s.branches[id] : undefined;
}

export function pathTurns(s: Session, branchId: string): Turn[] {
  const branch = getBranch(s, branchId);
  if (!branch) return [];
  let inherited: Turn[] = [];
  if (branch.parentId && branch.forkAfterTurnId) {
    const parentPath = pathTurns(s, branch.parentId);
    const idx = parentPath.findIndex((t) => t.id === branch.forkAfterTurnId);
    inherited = idx >= 0 ? parentPath.slice(0, idx + 1) : [];
  }
  return [...inherited, ...s.turns.filter((t) => t.branchId === branchId)];
}

export function headTurnId(s: Session, branchId: string): string | null {
  const path = pathTurns(s, branchId);
  return path.length ? path[path.length - 1].id : null;
}

function touch(s: Session, branchId: string, now: number): void {
  s.revision += 1;
  s.lastActivity = now;
  const b = getBranch(s, branchId);
  if (b) b.lastActiveAt = now;
}

export function appendTurn(
  s: Session,
  branchId: string,
  role: Turn['role'],
  text: string,
  now: number,
  kind?: Turn['kind'],
): Turn {
  if (!getBranch(s, branchId)) throw new Error(`unknown branch ${branchId}`);
  s.counters.turn += 1;
  const turn: Turn = { id: `t${s.counters.turn}`, branchId, role, text, at: now };
  if (kind) turn.kind = kind;
  s.turns.push(turn);
  touch(s, branchId, now);
  return turn;
}

export function forkBranch(
  s: Session,
  fromId: string,
  origin: 'fork' | 'correction',
  status: BranchStatus,
  now: number,
): Branch {
  if (!getBranch(s, fromId)) throw new Error(`unknown branch ${fromId}`);
  s.counters.branch += 1;
  const branch: Branch = {
    id: `b${s.counters.branch}`,
    parentId: fromId,
    forkAfterTurnId: headTurnId(s, fromId),
    name: NEW_NAME,
    status,
    origin,
    createdAt: now,
    lastActiveAt: now,
  };
  s.branches[branch.id] = branch;
  s.currentBranchId = branch.id;
  touch(s, branch.id, now);
  return branch;
}

export function switchTo(s: Session, branchId: string, now: number): boolean {
  const b = getBranch(s, branchId);
  if (!b) return false;
  if (s.currentBranchId === branchId) return true;
  s.currentBranchId = branchId;
  if (b.status === 'faded' || b.status === 'parked') b.status = 'live';
  touch(s, branchId, now);
  return true;
}

export function setStatus(s: Session, branchId: string, status: BranchStatus, now: number): void {
  const b = getBranch(s, branchId);
  if (!b) return;
  b.status = status;
  touch(s, branchId, now);
}

export function renameBranch(s: Session, branchId: string, name: string): void {
  const b = getBranch(s, branchId);
  if (b) b.name = name;
}

export function liveCount(s: Session): number {
  return Object.values(s.branches).filter((b) => b.status === 'live' || b.status === 'provisional').length;
}

/** Parks the branch, makes its parent current and returns the parent id. */
export function park(s: Session, branchId: string, now: number): string {
  const b = getBranch(s, branchId);
  if (!b) throw new Error(`unknown branch ${branchId}`);
  const parentId = b.parentId ?? branchId;
  if (parentId === branchId) return branchId; // the root cannot be parked
  b.status = 'parked';
  s.currentBranchId = parentId;
  const parent = getBranch(s, parentId);
  if (parent && (parent.status === 'faded' || parent.status === 'parked')) parent.status = 'live';
  touch(s, parentId, now);
  return parentId;
}

/** Folds away the branch's last user turn and the assistant reply after it. Nothing is deleted. */
export function scratchLast(s: Session, branchId: string): boolean {
  const own = s.turns.filter((t) => t.branchId === branchId && !t.scratched);
  let ui = -1;
  for (let i = own.length - 1; i >= 0; i--) if (own[i].role === 'user') { ui = i; break; }
  if (ui < 0) return false;
  own[ui].scratched = true;
  const reply = own[ui + 1];
  if (reply && reply.role === 'assistant') reply.scratched = true;
  s.revision += 1;
  return true;
}

function ancestry(s: Session, id: string): string[] {
  const chain: string[] = [];
  for (let b = getBranch(s, id); b; b = b.parentId ? getBranch(s, b.parentId) : undefined) chain.push(b.id);
  return chain;
}

export function commonAncestor(s: Session, a: string, b: string): string {
  const inA = new Set(ancestry(s, a));
  const hit = ancestry(s, b).find((id) => inA.has(id));
  if (!hit) throw new Error(`no common ancestor for ${a} and ${b}`);
  return hit;
}

/** Index in the ancestor's path where `x` leaves it (the head when x is the ancestor itself). */
function forkIndex(s: Session, ancestorId: string, x: string): number {
  const path = pathTurns(s, ancestorId);
  if (x === ancestorId) return path.length - 1;
  let cur = getBranch(s, x)!;
  while (cur.parentId !== ancestorId) cur = getBranch(s, cur.parentId!)!;
  return path.findIndex((t) => t.id === cur.forkAfterTurnId);
}

export function mergeBranches(s: Session, a: string, b: string, now: number): Branch {
  if (a === b || !getBranch(s, a) || !getBranch(s, b)) throw new Error(`cannot merge ${a} and ${b}`);
  const anc = commonAncestor(s, a, b);
  const idx = Math.min(forkIndex(s, anc, a), forkIndex(s, anc, b));
  const path = pathTurns(s, anc);
  s.counters.branch += 1;
  const branch: Branch = {
    id: `b${s.counters.branch}`,
    parentId: anc,
    forkAfterTurnId: idx >= 0 ? path[idx].id : null,
    name: 'Merged path',
    status: 'live',
    origin: 'merge',
    mergedFrom: [a, b],
    createdAt: now,
    lastActiveAt: now,
  };
  s.branches[branch.id] = branch;
  s.branches[a].status = 'faded';
  s.branches[b].status = 'faded';
  s.currentBranchId = branch.id;
  touch(s, branch.id, now);
  return branch;
}
