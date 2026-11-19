import { describe, it, expect } from 'vitest';
import { HUES, hueFor, mapRows, compactRows, PHONE_QUERY } from '../../public/js/branchMap.js';

const br = (id: string, parentId: string | null = null, status = 'live', extra: any = {}) => ({ id, name: id.toUpperCase(), status, parentId, ...extra });
const ids = (rows: any[]) => rows.map((r) => r.id);

describe('hueFor', () => {
  it('follows creation order and cycles', () => {
    const bs = Array.from({ length: 8 }, (_, i) => br(`b${i}`));
    expect(hueFor(bs, 'b0')).toBe(HUES[0]);
    expect(hueFor(bs, 'b1')).toBe(HUES[1]);
    expect(hueFor(bs, 'b6')).toBe(HUES[0]);
    expect(hueFor(bs, 'nope')).toBe(HUES[0]);
  });
});

describe('mapRows', () => {
  it('is empty without branches', () => {
    expect(mapRows([], 'a')).toEqual([]);
  });

  it('lists a single root', () => {
    expect(mapRows([br('a')], 'a')).toEqual([
      expect.objectContaining({ id: 'a', depth: 0, isCurrent: true, parentId: null, hue: HUES[0] }),
    ]);
  });

  it('goes depth-first with children in creation order', () => {
    const bs = [br('a'), br('b', 'a'), br('c', 'a'), br('d', 'b')];
    const rows = mapRows(bs, 'd');
    expect(ids(rows)).toEqual(['a', 'b', 'd', 'c']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1]);
    expect(rows.map((r) => r.parentId)).toEqual([null, 'a', 'b', 'a']);
  });

  it('marks only the current branch', () => {
    const rows = mapRows([br('a'), br('b', 'a')], 'b');
    expect(rows.map((r) => r.isCurrent)).toEqual([false, true]);
  });

  it('keeps hue stable by creation order, even past faded branches', () => {
    const bs = [br('a'), br('x', 'a', 'faded'), br('c', 'a')];
    const rows = mapRows(bs, 'c');
    expect(rows[1].hue).toBe(HUES[2]);
  });

  it('excludes faded branches and hangs their children from the nearest visible ancestor', () => {
    const bs = [br('a'), br('x', 'a', 'faded'), br('c', 'x')];
    const rows = mapRows(bs, 'c');
    expect(ids(rows)).toEqual(['a', 'c']);
    expect(rows[1]).toMatchObject({ depth: 1, parentId: 'a' });
  });

  it('shows a faded current branch rather than losing the cursor', () => {
    expect(ids(mapRows([br('a'), br('b', 'a', 'faded')], 'b'))).toEqual(['a', 'b']);
  });

  it('flags set-aside and provisional rows', () => {
    const rows = mapRows([br('a'), br('b', 'a', 'parked'), br('c', 'a', 'provisional')], 'a');
    expect(rows[1]).toMatchObject({ parked: true, provisional: false });
    expect(rows[2]).toMatchObject({ parked: false, provisional: true });
  });

  it('shows a merged branch as one row; its faded sources are gone', () => {
    const bs = [br('a'), br('b', 'a', 'faded'), br('c', 'a', 'faded'), br('m', 'a', 'live', { mergedFrom: ['b', 'c'] })];
    const rows = mapRows(bs, 'm');
    expect(ids(rows)).toEqual(['a', 'm']);
    expect(rows[1]).toMatchObject({ merged: true, depth: 1 });
  });

  it('survives a parent cycle without looping', () => {
    const bs = [br('a', 'b', 'faded'), br('b', 'a', 'faded'), br('c', 'a')];
    expect(ids(mapRows(bs, 'c'))).toEqual(['c']);
  });

  it('is deterministic', () => {
    const bs = [br('a'), br('b', 'a'), br('c', 'a', 'parked')];
    expect(mapRows(bs, 'b')).toEqual(mapRows(bs, 'b'));
  });
});

describe('compactRows', () => {
  const rowsOf = (bs: any[], cur: string) => mapRows(bs, cur);

  it('leaves three rows or fewer alone', () => {
    const rows = rowsOf([br('a'), br('b', 'a'), br('c', 'a')], 'b');
    expect(compactRows(rows)).toEqual({ rows, more: 0 });
  });

  it('keeps the current branch and its parent, re-based, plus a count', () => {
    const rows = rowsOf([br('a'), br('b', 'a'), br('c', 'b'), br('d', 'a'), br('e', 'c')], 'c');
    const out = compactRows(rows);
    expect(ids(out.rows)).toEqual(['b', 'c']);
    expect(out.rows.map((r) => r.depth)).toEqual([0, 1]);
    expect(out.rows.map((r) => r.parentId)).toEqual([null, 'b']);
    expect(out.more).toBe(3);
  });

  it('shows only the current branch when it is a root', () => {
    const rows = rowsOf([br('a'), br('b', 'a'), br('c', 'a'), br('d', 'a')], 'a');
    const out = compactRows(rows);
    expect(ids(out.rows)).toEqual(['a']);
    expect(out.rows[0]).toEqual(expect.objectContaining({ depth: 0, parentId: null, isCurrent: true }));
    expect(out.more).toBe(3);
  });

  it('never leaves an orphan stem when the parent is not shown', () => {
    const rows = rowsOf([br('a'), br('b', 'a', 'faded'), br('c', 'b'), br('d', 'a'), br('e', 'a')], 'c');
    const out = compactRows(rows); // c hangs from a (b is faded); a is its visible parent
    expect(ids(out.rows)).toEqual(['a', 'c']);
    expect(out.rows[1].parentId).toBe('a');
  });

  it('does not mutate its input and respects a custom max', () => {
    const rows = rowsOf([br('a'), br('b', 'a'), br('c', 'b')], 'c');
    const copy = JSON.parse(JSON.stringify(rows));
    expect(compactRows(rows, 2).rows).toHaveLength(2);
    expect(rows).toEqual(copy);
  });
});

describe('PHONE_QUERY', () => {
  it('covers narrow screens and coarse pointers', () => {
    expect(PHONE_QUERY).toContain('max-width: 600px');
    expect(PHONE_QUERY).toContain('pointer: coarse');
  });
});

describe('corrections keep their parent hue', () => {
  const bs = [br('a'), br('b', 'a'), br('c', 'b', 'live', { origin: 'correction' }), br('d', 'c', 'live', { origin: 'correction' }), br('e', 'a')];
  it('takes the hue of the branch it corrects, following the chain', () => {
    expect(hueFor(bs, 'c')).toBe(hueFor(bs, 'b'));
    expect(hueFor(bs, 'd')).toBe(hueFor(bs, 'b'));
    expect(hueFor(bs, 'e')).toBe(HUES[4]);
  });
  it('mapRows rows agree with hueFor', () => {
    for (const r of mapRows(bs, 'd')) expect(r.hue).toBe(hueFor(bs, r.id));
  });
});

describe('mapRows keepMerged (end screen)', () => {
  // Japan, Hokkaido under it, a correction copy of Hokkaido, and the merge of Japan with the copy
  const bs = [
    br('b1', null, 'faded'),
    br('b3', 'b1', 'faded', { origin: 'fork' }),
    br('b4', 'b3', 'faded', { origin: 'correction' }),
    br('b5', 'b1', 'live', { origin: 'merge', mergedFrom: ['b1', 'b4'] }),
  ];
  it('keeps merge sources, one row per correction, and the merged row', () => {
    const rows = mapRows(bs, 'b5', { keepMerged: true });
    expect(ids(rows)).toEqual(['b1', 'b4', 'b5']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
    expect(rows.map((r) => r.faded)).toEqual([true, true, false]);
    expect(rows[1].hue).toBe(hueFor(bs, 'b3'));
  });
  it('the live map is unchanged', () => {
    expect(ids(mapRows(bs, 'b5'))).toEqual(['b5']);
  });
});
