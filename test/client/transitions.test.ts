import { describe, it, expect } from 'vitest';
import { detectTransition, isInformational } from '../../public/js/transitions.js';

const b = (id: string, origin = 'root', status = 'active') => ({ id, origin, status });
const st = (current: string, branches: any[]) => ({ sheets: { current: { id: current } }, branches });

describe('detectTransition', () => {
  const prev = st('a', [b('a')]);
  it('none when nothing changed', () => {
    expect(detectTransition(prev, st('a', [b('a')])).kind).toBe('none');
  });
  it('fork to a newly created fork branch', () => {
    expect(detectTransition(prev, st('f', [b('a'), b('f', 'fork')]))).toEqual({ kind: 'fork', from: 'a', to: 'f' });
  });
  it('correction to a newly created correction branch', () => {
    expect(detectTransition(prev, st('c', [b('a'), b('c', 'correction')])).kind).toBe('correction');
  });
  it('switch to an existing branch', () => {
    const p = st('a', [b('a'), b('x')]);
    expect(detectTransition(p, st('x', [b('a'), b('x')]))).toEqual({ kind: 'switch', from: 'a', to: 'x' });
  });
  it('fade when same current and a branch became faded', () => {
    const p = st('a', [b('a'), b('x')]);
    expect(detectTransition(p, st('a', [b('a'), b('x', 'fork', 'faded')])).kind).toBe('fade');
  });
  it('already-faded branch is not a fade', () => {
    const p = st('a', [b('a'), b('x', 'fork', 'faded')]);
    expect(detectTransition(p, p).kind).toBe('none');
  });
  it('fork+switch in one poll: switch wins (single result)', () => {
    const p = st('a', [b('a'), b('x')]);
    const n = st('x', [b('a'), b('x'), b('f', 'fork')]);
    expect(detectTransition(p, n).kind).toBe('switch');
  });
  it('fork beats fade', () => {
    const p = st('a', [b('a'), b('x')]);
    const n = st('f', [b('a'), b('x', 'fork', 'faded'), b('f', 'fork')]);
    expect(detectTransition(p, n).kind).toBe('fork');
  });
  it('correction beats fade', () => {
    const p = st('a', [b('a'), b('x')]);
    const n = st('c', [b('a'), b('x', 'fork', 'faded'), b('c', 'correction')]);
    expect(detectTransition(p, n).kind).toBe('correction');
  });
  it('fork beats correction when both are new (current is the fork)', () => {
    const p = st('a', [b('a')]);
    const n = st('f', [b('a'), b('c', 'correction'), b('f', 'fork')]);
    expect(detectTransition(p, n).kind).toBe('fork');
  });
  it('no prev yields none', () => {
    expect(detectTransition(null, prev).kind).toBe('none');
  });

  describe('command transitions', () => {
    const full = (current: string, branches: any[], extra: any = {}) => ({
      sheets: { current: { id: current, name: current, status: 'live' }, others: [], parked: [], peek: null }, branches, ...extra,
    });
    const dec = (kind: string, otherId?: string, ms = 1) => ({ lastDecision: { op: { kind, otherId }, ms }, revision: 1 });

    it('merge: a new current branch with origin merge', () => {
      const p = full('a', [b('a'), b('x')]);
      const n = full('m', [b('a', 'root', 'faded'), b('x', 'fork', 'faded'), { ...b('m', 'merge'), mergedFrom: ['a', 'x'] }]);
      expect(detectTransition(p, n)).toEqual({ kind: 'merge', from: 'a', to: 'm', sources: ['a', 'x'] });
    });
    it('park: current became the parent of a branch that is now parked', () => {
      const p = full('x', [b('a'), { ...b('x', 'fork'), parentId: 'a' }]);
      const n = full('a', [b('a'), { ...b('x', 'fork', 'parked'), parentId: 'a' }]);
      expect(detectTransition(p, n)).toEqual({ kind: 'park', from: 'x', to: 'a' });
    });
    it('switch to an existing branch that parks nothing stays a switch', () => {
      const p = full('a', [b('a'), b('x')]);
      expect(detectTransition(p, full('x', [b('a'), b('x')])).kind).toBe('switch');
    });
    it('recap from a new lastDecision with no structural change', () => {
      const p = full('a', [b('a')]);
      expect(detectTransition(p, full('a', [b('a')], dec('recap'))).kind).toBe('recap');
    });
    it('compare carries the other branch id', () => {
      const p = full('a', [b('a'), b('x')]);
      expect(detectTransition(p, full('a', [b('a'), b('x')], dec('compare', 'x')))).toEqual({ kind: 'compare', other: 'x' });
    });
    it('the same decision seen again (next poll) does not replay', () => {
      const d = dec('recap');
      const p = full('a', [b('a')], d);
      expect(detectTransition(p, full('a', [b('a')], { ...d, revision: 2 })).kind).toBe('none');
    });
    it('other decision kinds are not animations', () => {
      const p = full('a', [b('a')]);
      expect(detectTransition(p, full('a', [b('a')], dec('continue'))).kind).toBe('none');
    });
  });

  describe('deferred structure changes', () => {
    const view = (name: string, status: string, others: any[] = []) => ({
      sheets: { current: { id: 'a', name, status, originName: null }, others, parked: [], peek: null }, branches: [b('a')],
    });
    it('provisional to live is a refresh the queue can hold back', () => {
      expect(detectTransition(view('Main', 'provisional'), view('Main', 'live')).kind).toBe('refresh');
    });
    it('a rename is a refresh', () => {
      expect(detectTransition(view('New', 'live'), view('Newsletter', 'live')).kind).toBe('refresh');
    });
    it('a third live branch appearing in others is a refresh', () => {
      expect(detectTransition(view('Main', 'live'), view('Main', 'live', [{ id: 'z', name: 'Z' }])).kind).toBe('refresh');
    });
    it('identical structure is none', () => {
      expect(detectTransition(view('Main', 'live'), view('Main', 'live')).kind).toBe('none');
    });
  });
});

describe('isInformational', () => {
  it('recap and compare play now (they change no structure); structural transitions do not', () => {
    expect(isInformational({ kind: 'recap' })).toBe(true);
    expect(isInformational({ kind: 'compare', other: 'x' })).toBe(true);
    for (const kind of ['fork', 'merge', 'switch', 'park', 'fade', 'correction', 'refresh']) expect(isInformational({ kind })).toBe(false);
  });
});
