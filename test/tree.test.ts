import { describe, it, expect } from 'vitest';
import { createSession, appendTurn, forkBranch, pathTurns, headTurnId, switchTo, setStatus, renameBranch, park, scratchLast, commonAncestor, mergeBranches, liveCount } from '../src/tree/tree.js';

describe('session tree', () => {
  it('creates a session with one live root branch named Main', () => {
    const s = createSession('s1', 0);
    expect(Object.keys(s.branches)).toEqual(['b1']);
    expect(s.branches.b1).toMatchObject({ name: 'Main', status: 'live', origin: 'root', parentId: null, forkAfterTurnId: null });
    expect(s.currentBranchId).toBe('b1');
    expect(s.revision).toBe(0);
  });

  it('a fork inherits the parent path up to the fork point only', () => {
    const s = createSession('s1', 0);
    const t1 = appendTurn(s, 'b1', 'user', 'newsletter idea', 1);
    appendTurn(s, 'b1', 'assistant', 'weekly?', 2);
    const f = forkBranch(s, 'b1', 'fork', 'provisional', 3);
    expect(f).toMatchObject({ id: 'b2', parentId: 'b1', name: 'New path', status: 'provisional', origin: 'fork' });
    expect(f.forkAfterTurnId).toBe(headTurnId(s, 'b1'));
    expect(s.currentBranchId).toBe('b2');
    appendTurn(s, 'b1', 'user', 'later on main', 4); // after the fork: not inherited
    appendTurn(s, 'b2', 'user', 'what about a podcast', 5);
    expect(pathTurns(s, 'b2').map((t) => t.text)).toEqual(['newsletter idea', 'weekly?', 'what about a podcast']);
    expect(pathTurns(s, 'b1').map((t) => t.text)).toEqual(['newsletter idea', 'weekly?', 'later on main']);
    expect(t1.id).toBe('t1');
  });

  it('nested forks inherit through every ancestor', () => {
    const s = createSession('s1', 0);
    appendTurn(s, 'b1', 'user', 'a', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2);
    appendTurn(s, 'b2', 'user', 'b', 3);
    forkBranch(s, 'b2', 'fork', 'live', 4);
    appendTurn(s, 'b3', 'user', 'c', 5);
    expect(pathTurns(s, 'b3').map((t) => t.text)).toEqual(['a', 'b', 'c']);
  });

  it('switching to a faded branch makes it live; unknown ids return false; revision only grows', () => {
    const s = createSession('s1', 0);
    forkBranch(s, 'b1', 'fork', 'live', 1);
    setStatus(s, 'b1', 'faded', 2);
    const r0 = s.revision;
    expect(switchTo(s, 'b1', 3)).toBe(true);
    expect(s.branches.b1.status).toBe('live');
    expect(s.revision).toBeGreaterThan(r0);
    expect(switchTo(s, 'nope', 4)).toBe(false);
  });

  it('switching to the current branch is a no-op that does not bump revision', () => {
    const s = createSession('s1', 0);
    const r0 = s.revision;
    expect(switchTo(s, 'b1', 1)).toBe(true);
    expect(s.revision).toBe(r0);
  });

  it('rename does not bump revision; nothing is ever removed', () => {
    const s = createSession('s1', 0);
    appendTurn(s, 'b1', 'user', 'x', 1);
    forkBranch(s, 'b1', 'fork', 'provisional', 2);
    setStatus(s, 'b2', 'faded', 3);
    const r = s.revision;
    renameBranch(s, 'b2', 'Podcast');
    expect(s.revision).toBe(r);
    expect(s.branches.b2.name).toBe('Podcast');
    expect(Object.keys(s.branches)).toHaveLength(2);
    expect(s.turns).toHaveLength(1);
  });

  it('rejects inherited keys as branch ids', () => {
    const s = createSession('s', 0);
    expect(switchTo(s, 'constructor', 1)).toBe(false);
    expect(switchTo(s, '__proto__', 1)).toBe(false);
    expect(s.currentBranchId).toBe('b1');
    expect(() => forkBranch(s, 'constructor', 'fork', 'live', 1)).toThrow();
    expect(() => appendTurn(s, 'toString', 'user', 'x', 1)).toThrow();
  });

  describe('park, scratch, merge', () => {
    function forked() {
      const s = createSession('s', 0);
      appendTurn(s, 'b1', 'user', 'idea', 1);
      appendTurn(s, 'b1', 'assistant', 'ok', 2);
      forkBranch(s, 'b1', 'fork', 'live', 3);
      appendTurn(s, 'b2', 'user', 'podcast', 4);
      s.currentBranchId = 'b1';
      forkBranch(s, 'b1', 'fork', 'live', 5);
      appendTurn(s, 'b3', 'user', 'video', 6);
      return s;
    }
    it('park sets parked, makes the parent current and returns it; switching back makes it live', () => {
      const s = forked();
      expect(park(s, 'b3', 7)).toBe('b1');
      expect(s.branches.b3.status).toBe('parked');
      expect(s.currentBranchId).toBe('b1');
      switchTo(s, 'b3', 8);
      expect(s.branches.b3.status).toBe('live');
    });
    it('park revives a parked or faded parent so the current branch is live', () => {
      const s = forked();
      s.branches.b1.status = 'parked';
      park(s, 'b3', 7);
      expect(s.branches.b1.status).toBe('live');
      s.currentBranchId = 'b2';
      s.branches.b1.status = 'faded';
      park(s, 'b2', 8);
      expect(s.branches.b1.status).toBe('live');
    });
    it('scratchLast scratches the last user turn and the reply after it', () => {
      const s = createSession('s', 0);
      appendTurn(s, 'b1', 'user', 'a', 1);
      appendTurn(s, 'b1', 'assistant', 'b', 2);
      appendTurn(s, 'b1', 'user', 'c', 3);
      appendTurn(s, 'b1', 'assistant', 'd', 4);
      expect(scratchLast(s, 'b1')).toBe(true);
      expect(s.turns.map((t) => !!t.scratched)).toEqual([false, false, true, true]);
      expect(scratchLast(s, 'b1')).toBe(true);
      expect(s.turns.every((t) => t.scratched)).toBe(true);
      expect(scratchLast(s, 'b1')).toBe(false);
    });
    it('scratchLast returns false on an empty branch and does not touch inherited turns', () => {
      const s = forked();
      expect(scratchLast(s, 'b1')).toBe(true);
      const e = createSession('e', 0);
      const rev = e.revision;
      expect(scratchLast(e, 'b1')).toBe(false);
      expect(e.revision).toBe(rev);
      forkBranch(s, 'b1', 'fork', 'live', 9);
      expect(scratchLast(s, 'b4')).toBe(false);
    });
    it('commonAncestor', () => {
      const s = forked();
      expect(commonAncestor(s, 'b2', 'b3')).toBe('b1');
      expect(commonAncestor(s, 'b2', 'b2')).toBe('b2');
      expect(commonAncestor(s, 'b1', 'b3')).toBe('b1');
    });
    it('mergeBranches fades both, records sources and inherits only the common prefix', () => {
      const s = forked();
      const m = mergeBranches(s, 'b2', 'b3', 10);
      expect(m).toMatchObject({ parentId: 'b1', origin: 'merge', mergedFrom: ['b2', 'b3'], status: 'live' });
      expect(s.branches.b2.status).toBe('faded');
      expect(s.branches.b3.status).toBe('faded');
      expect(s.currentBranchId).toBe(m.id);
      expect(pathTurns(s, m.id).map((t) => t.text)).toEqual(['idea', 'ok']);
    });
    it('merge fork point is the earlier of the two forks', () => {
      const s = createSession('s', 0);
      appendTurn(s, 'b1', 'user', 'one', 1);
      forkBranch(s, 'b1', 'fork', 'live', 2);
      s.currentBranchId = 'b1';
      appendTurn(s, 'b1', 'user', 'two', 3);
      forkBranch(s, 'b1', 'fork', 'live', 4);
      const m = mergeBranches(s, 'b2', 'b3', 5);
      expect(pathTurns(s, m.id).map((t) => t.text)).toEqual(['one']);
      const m2 = mergeBranches(s, 'b1', 'b3', 6);
      expect(m2.parentId).toBe('b1');
      expect(pathTurns(s, m2.id).map((t) => t.text)).toEqual(['one', 'two']);
    });
    it('liveCount counts live and provisional only', () => {
      const s = forked();
      expect(liveCount(s)).toBe(3);
      setStatus(s, 'b2', 'parked', 11);
      setStatus(s, 'b3', 'faded', 12);
      expect(liveCount(s)).toBe(1);
      setStatus(s, 'b3', 'provisional', 13);
      expect(liveCount(s)).toBe(2);
    });
  });
});
