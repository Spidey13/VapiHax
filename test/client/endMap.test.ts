import { describe, it, expect } from 'vitest';
import { mapBranches } from '../../public/js/endPage.js';
import { mapRows, hueFor } from '../../public/js/branchMap.js';

// Shape of the real share data of the Japan trip session (b4 is a correction copy of b3, b5 merges b1 and b4).
const data = {
  map: {
    nodes: [
      { id: 'b1', label: 'Japan trip', status: 'faded' },
      { id: 'b3', label: 'Hokkaido', status: 'faded' },
      { id: 'b4', label: 'Hokkaido', status: 'faded' },
      { id: 'b5', label: 'Japan + Hokkaido', status: 'live' },
    ],
    edges: [{ from: 'b1', to: 'b3' }, { from: 'b3', to: 'b4' }, { from: 'b1', to: 'b5' }],
    mergeEdges: [{ from: 'b1', to: 'b5' }, { from: 'b4', to: 'b5' }],
  },
  branches: [
    { id: 'b1', name: 'Japan trip' }, { id: 'b3', name: 'Hokkaido' }, { id: 'b4', name: 'Hokkaido' }, { id: 'b5', name: 'Japan + Hokkaido' },
  ],
};

describe('end map', () => {
  const bs = mapBranches(data);
  const rows = mapRows(bs, 'b5', { keepMerged: true });
  it('shows the whole tree: sources dimmed, the correction copy as one row, the merge current', () => {
    expect(rows.map((r) => [r.id, r.name, r.depth, r.faded, r.isCurrent, r.merged])).toEqual([
      ['b1', 'Japan trip', 0, true, false, false],
      ['b4', 'Hokkaido', 1, true, false, false],
      ['b5', 'Japan + Hokkaido', 1, false, true, true],
    ]);
  });
  it('the copy keeps Hokkaido hue, same for every caller', () => {
    expect(rows[1].hue).toBe(hueFor(bs, 'b3'));
    expect(rows[1].hue).not.toBe(rows[0].hue);
    for (const r of rows) expect(r.hue).toBe(hueFor(bs, r.id));
  });
});

describe('end map with explicit origin', () => {
  const withOrigin = {
    ...data,
    branches: [
      { id: 'b1', name: 'Japan trip', origin: 'root' },
      { id: 'b3', name: 'Hokkaido', origin: 'fork' },
      { id: 'b4', name: 'Hokkaido', origin: 'fork' }, // a genuine same-named fork: the name heuristic must not call it a copy
      { id: 'b5', name: 'Japan + Hokkaido', origin: 'merge' },
    ],
  };
  it('uses the payload origin before any name heuristic', () => {
    expect(mapBranches(withOrigin).map((b: any) => b.origin)).toEqual(['root', 'fork', 'fork', 'merge']);
  });
  it('falls back to the heuristic for payloads without origin', () => {
    expect(mapBranches(data).map((b: any) => b.origin)).toEqual(['root', 'fork', 'correction', 'merge']);
  });
  it('keeps hues stable', () => {
    const bs = mapBranches(withOrigin);
    for (const b of bs) expect(hueFor(bs, b.id)).toBe(hueFor(mapBranches(withOrigin), b.id));
  });
});
