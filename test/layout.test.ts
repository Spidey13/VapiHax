import { describe, it, expect } from 'vitest';
import { layoutTree } from '../src/view/layout.js';
import type { Branch } from '../src/tree/types.js';

function b(id: string, parentId: string | null, createdAt: number, extra: Partial<Branch> = {}): Branch {
  return {
    id, parentId, forkAfterTurnId: null, name: id, status: 'live',
    origin: parentId ? 'fork' : 'root', createdAt, lastActiveAt: createdAt, ...extra,
  };
}

describe('layoutTree', () => {
  it('single root: one node, no edges', () => {
    const r = layoutTree([b('r', null, 1)]);
    expect(r.nodes).toHaveLength(1);
    expect(r.edges).toEqual([]);
    expect(r.mergeEdges).toEqual([]);
    expect(r.nodes[0].y).toBeLessThan(r.height);
  });

  it('root with two forks: children below, left/right, root centred', () => {
    const r = layoutTree([b('r', null, 1), b('b', 'r', 3), b('a', 'r', 2)]);
    const n = Object.fromEntries(r.nodes.map((x) => [x.id, x]));
    expect(n.a.y).toBeGreaterThan(n.r.y);
    expect(n.a.y).toBe(n.b.y);
    expect(n.a.x).toBeLessThan(n.r.x);
    expect(n.b.x).toBeGreaterThan(n.r.x);
    expect(n.r.x).toBe((n.a.x + n.b.x) / 2);
    expect(r.edges).toEqual(expect.arrayContaining([{ from: 'r', to: 'a' }, { from: 'r', to: 'b' }]));
  });

  it('is deterministic, ties on createdAt break by id', () => {
    const bs = [b('r', null, 1), b('z', 'r', 2), b('y', 'r', 2)];
    const one = layoutTree(bs);
    expect(layoutTree([...bs].reverse())).toEqual(one);
    const n = Object.fromEntries(one.nodes.map((x) => [x.id, x]));
    expect(n.y.x).toBeLessThan(n.z.x);
  });

  it('eight leaves: distinct x, width grows', () => {
    const bs = [b('r', null, 0)];
    for (let i = 0; i < 8; i++) bs.push(b('l' + i, 'r', i + 1));
    const r = layoutTree(bs, { colWidth: 100 });
    const xs = r.nodes.filter((x) => x.id !== 'r').map((x) => x.x);
    expect(new Set(xs).size).toBe(8);
    expect(r.width).toBeGreaterThanOrEqual(800);
    const sorted = [...xs].sort((p, q) => p - q);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(100);
  });

  it('cuts long labels surrogate-safely to maxLabel with an ellipsis', () => {
    const r = layoutTree([b('r', null, 1, { name: 'x'.repeat(30) }), b('e', 'r', 2, { name: '😀'.repeat(30) })]);
    const n = Object.fromEntries(r.nodes.map((x) => [x.id, x]));
    expect(Array.from(n.r.label)).toHaveLength(18);
    expect(n.r.label.endsWith('…')).toBe(true);
    expect(Array.from(n.e.label)).toHaveLength(18);
    expect(n.e.label).toBe('😀'.repeat(17) + '…');
    expect(layoutTree([b('s', null, 1, { name: 'short' })]).nodes[0].label).toBe('short');
  });

  it('returns merge edges from each source to the merged branch', () => {
    const r = layoutTree([
      b('r', null, 1), b('a', 'r', 2), b('c', 'r', 3),
      b('m', 'r', 4, { origin: 'merge', mergedFrom: ['a', 'c'] }),
    ]);
    expect(r.mergeEdges).toEqual([{ from: 'a', to: 'm' }, { from: 'c', to: 'm' }]);
    expect(r.edges.filter((e) => e.to === 'm')).toEqual([{ from: 'r', to: 'm' }]);
  });
});
