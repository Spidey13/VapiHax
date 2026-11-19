import { describe, expect, it } from 'vitest';
import { score, type EvalItem } from '../src/route/score.js';
import type { Op, RouteDecision, RouteInput } from '../src/route/types.js';

const input: RouteInput = { utterance: 'x', current: { id: 'b1', name: 'Main', summary: '', provisional: false, lastUser: 'hi', lastAssistant: 'hello' }, others: [] };
const item = (id: string, expectKind: Op['kind'], expectTarget?: string): EvalItem => ({ id, input, expect: expectKind, expectTarget });
const got = (op: Op, ms: number): RouteDecision => ({ op, intent: null, by: 'jev', ms, reason: '' });

describe('score', () => {
  const rows = [
    { item: item('a', 'fork'), got: got({ kind: 'fork', acknowledge: false }, 100) },
    { item: item('b', 'correct'), got: got({ kind: 'fork', acknowledge: false }, 200) },
    { item: item('c', 'continue'), got: got({ kind: 'continue' }, 300) },
    { item: item('d', 'switch', 'b2'), got: got({ kind: 'switch', targetId: 'b3' }, 400) },
  ];
  const s = score(rows);

  it('computes accuracy, confusion and false-fork rate', () => {
    expect(s.accuracy).toBe(0.5);
    expect(s.confusion.correct.fork).toBe(1);
    expect(s.falseForkRate).toBe(0.5);
  });

  it('counts a switch to the wrong target as wrong', () => {
    expect(s.perKind.switch.recall).toBe(0);
    expect(s.perKind.fork.precision).toBe(0.5);
    expect(s.perKind.fork.recall).toBe(1);
  });

  it('reports latency percentiles', () => {
    expect(s.p50Ms).toBe(200);
    expect(s.p90Ms).toBe(400);
  });

  it('handles no rows', () => {
    expect(score([]).accuracy).toBe(0);
  });

  it('counts compare and merge rows with the wrong otherId as wrong', () => {
    const r = score([
      { item: item('c1', 'compare', 'b2'), got: got({ kind: 'compare', otherId: 'b3' }, 1) },
      { item: item('c2', 'compare', 'b2'), got: got({ kind: 'compare', otherId: 'b2' }, 1) },
      { item: item('m1', 'merge', 'b2'), got: got({ kind: 'merge', otherId: 'b3' }, 1) },
      { item: item('m2', 'merge', 'b2'), got: got({ kind: 'merge', otherId: 'b2' }, 1) },
    ]);
    expect(r.accuracy).toBe(0.5);
    expect(r.perKind.compare.recall).toBe(0.5);
    expect(r.perKind.merge.recall).toBe(0.5);
  });
});
