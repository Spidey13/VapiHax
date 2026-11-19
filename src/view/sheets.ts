import type { BranchStatus, Session, Turn } from '../tree/types.js';
import { getBranch, pathTurns } from '../tree/tree.js';

export interface SheetView {
  id: string;
  name: string;
  status: BranchStatus;
  originName: string | null;
}

const LAST_LINE_MAX = 90;

function sheetOf(s: Session, id: string): SheetView {
  const b = getBranch(s, id)!;
  const parent = b.parentId ? getBranch(s, b.parentId) : undefined;
  return {
    id: b.id,
    name: b.name,
    status: b.status,
    originName: parent && parent.status !== 'faded' ? parent.name : null,
  };
}

/** Scratched turns fold away: they stay in the data model but are not drawn. */
function shownPath(s: Session, id: string): Turn[] {
  return pathTurns(s, id).filter((t) => !t.scratched);
}

function withLastLine(s: Session, id: string): SheetView & { lastLine: string } {
  const path = shownPath(s, id);
  const last = path.length ? path[path.length - 1].text : '';
  return { ...sheetOf(s, id), lastLine: Array.from(last).slice(0, LAST_LINE_MAX).join('') };
}

export function sheetsView(s: Session): {
  current: SheetView & { path: Turn[] };
  peek: (SheetView & { lastLine: string }) | null;
  others: (SheetView & { lastLine: string })[];
  parked: (SheetView & { lastLine: string })[];
} {
  const rest = Object.values(s.branches).filter((b) => b.id !== s.currentBranchId);
  const parked = rest.filter((b) => b.status === 'parked').map((b) => withLastLine(s, b.id));
  // Most recently active first; on a tie the later-created branch wins (as peek always did).
  const others = rest
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.status !== 'faded' && b.status !== 'parked')
    .sort((x, y) => y.b.lastActiveAt - x.b.lastActiveAt || y.i - x.i)
    .map(({ b }) => withLastLine(s, b.id));
  return {
    current: { ...sheetOf(s, s.currentBranchId), path: shownPath(s, s.currentBranchId) },
    peek: others[0] ?? null,
    others,
    parked,
  };
}
