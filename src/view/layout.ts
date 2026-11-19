import type { Branch, BranchStatus } from '../tree/types.js';

export interface LayoutNode { id: string; x: number; y: number; label: string; status: BranchStatus }
export interface LayoutEdge { from: string; to: string }
export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  mergeEdges: LayoutEdge[];
  width: number;
  height: number;
}

function cut(name: string, max: number): string {
  const chars = Array.from(name);
  return chars.length > max ? chars.slice(0, Math.max(0, max - 1)).join('') + '…' : name;
}

/** Pure, deterministic top-down tree layout: depth = rows, leaves take columns left to right. */
export function layoutTree(
  branches: Branch[],
  opts: { colWidth?: number; rowHeight?: number; maxLabel?: number } = {},
): Layout {
  const colWidth = opts.colWidth ?? 140;
  const rowHeight = opts.rowHeight ?? 90;
  const maxLabel = opts.maxLabel ?? 18;

  const byId = new Map(branches.map((br) => [br.id, br]));
  const order = (a: Branch, c: Branch) => a.createdAt - c.createdAt || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0);
  const kids = new Map<string, Branch[]>();
  const roots: Branch[] = [];
  for (const br of branches) {
    if (br.parentId !== null && byId.has(br.parentId) && br.parentId !== br.id) {
      const list = kids.get(br.parentId) ?? [];
      list.push(br);
      kids.set(br.parentId, list);
    } else roots.push(br);
  }
  roots.sort(order);
  for (const list of kids.values()) list.sort(order);

  const pos = new Map<string, { col: number; depth: number }>();
  let nextCol = 0;
  let maxDepth = 0;
  const place = (br: Branch, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth);
    const children = (kids.get(br.id) ?? []).filter((c) => !pos.has(c.id));
    let col: number;
    pos.set(br.id, { col: 0, depth }); // mark visited (cycle guard)
    if (children.length === 0) col = nextCol++;
    else {
      const cols = children.map((c) => place(c, depth + 1));
      col = cols.reduce((s, c) => s + c, 0) / cols.length;
    }
    pos.set(br.id, { col, depth });
    return col;
  };
  for (const r of roots) place(r, 0);

  const nodes: LayoutNode[] = [];
  for (const br of [...roots, ...branches.filter((x) => !roots.includes(x))].sort(order)) {
    const p = pos.get(br.id);
    if (!p) continue;
    nodes.push({
      id: br.id,
      x: p.col * colWidth + colWidth / 2,
      y: p.depth * rowHeight + rowHeight / 2,
      label: cut(br.name, maxLabel),
      status: br.status,
    });
  }

  const edges: LayoutEdge[] = [];
  const mergeEdges: LayoutEdge[] = [];
  for (const br of [...branches].sort(order)) {
    if (!pos.has(br.id)) continue;
    if (br.parentId !== null && byId.has(br.parentId) && pos.has(br.parentId)) edges.push({ from: br.parentId, to: br.id });
    for (const src of br.mergedFrom ?? []) if (pos.has(src)) mergeEdges.push({ from: src, to: br.id });
  }

  return {
    nodes,
    edges,
    mergeEdges,
    width: Math.max(1, nextCol) * colWidth,
    height: (maxDepth + 1) * rowHeight,
  };
}
