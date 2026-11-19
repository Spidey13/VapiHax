import { describe, expect, it } from 'vitest';
import { appendTurn, createSession, forkBranch, renameBranch, setStatus } from '../src/tree/tree.js';
import { applyDecision } from '../src/turn/apply.js';
import { FORK_ACK, NOTHING_TO_SCRATCH, ONLY_ONE_THREAD, PARKED, SCRATCHED } from '../src/reply/copy.js';
import { askWhichInstruction, compareInstruction, mergeOpeningInstruction, parkedReminderInstruction, recapInstruction, setAsideInstruction } from '../src/reply/prompts.js';
import type { Op, RouteDecision } from '../src/route/types.js';

const d = (op: Op): RouteDecision => ({ op, intent: null, by: 'jev', ms: 1, reason: '' });

describe('applyDecision', () => {
  it('fork creates a provisional branch from the current head; ack only when asked', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'newsletter', 1);
    const r = applyDecision(s, d({ kind: 'fork', acknowledge: true }), 2);
    expect(r).toMatchObject({ branchId: 'b2', prefix: FORK_ACK, forked: true });
    expect(s.branches.b2.status).toBe('provisional');
    expect(applyDecision(s, d({ kind: 'fork', acknowledge: false }), 3).prefix).toBeNull();
  });
  it('continue on a provisional branch promotes it to live', () => {
    const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'provisional', 1);
    applyDecision(s, d({ kind: 'continue' }), 2);
    expect(s.branches.b2.status).toBe('live');
  });
  it('switching back to the parent of a provisional branch fades it and confirms by name', () => {
    const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'provisional', 1);
    const r = applyDecision(s, d({ kind: 'switch', targetId: 'b1' }), 2);
    expect(s.branches.b2.status).toBe('faded');
    expect(r).toMatchObject({ branchId: 'b1', prefix: 'Back to Main.' });
  });
  it('a new direction while provisional fades it and forks from its parent', () => {
    const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'provisional', 1);
    const r = applyDecision(s, d({ kind: 'fork', acknowledge: false }), 2);
    expect(s.branches.b2.status).toBe('faded');
    expect(s.branches[r.branchId].parentId).toBe('b1');
  });
  it('a correction forks a live correction branch, fades the old one and keeps the name', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'three people', 1);
    const r = applyDecision(s, d({ kind: 'correct' }), 2);
    expect(s.branches.b1.status).toBe('faded');
    expect(s.branches[r.branchId]).toMatchObject({ origin: 'correction', status: 'live', name: 'Main' });
    expect(r).toMatchObject({ kind: 'correction', prefix: null, forked: false });
  });
  it('ask-which stays put and returns an instruction naming the other live branches', () => {
    const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'live', 1); renameBranch(s, 'b1', 'Newsletter');
    const r = applyDecision(s, d({ kind: 'ask-which' }), 2);
    expect(r.branchId).toBe('b2');
    expect(r.instruction).toBe(askWhichInstruction(['Newsletter']));
  });
  it('ask-which with no other live branches behaves as continue', () => {
    const s = createSession('s', 0);
    const r = applyDecision(s, d({ kind: 'ask-which' }), 2);
    expect(r).toMatchObject({ branchId: 'b1', prefix: null, instruction: null, forked: false });
  });

  describe('commands', () => {
    it('park makes the parent current and prefixes PARKED', () => {
      const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'live', 1);
      const r = applyDecision(s, d({ kind: 'park' }), 2);
      expect(r).toMatchObject({ branchId: 'b1', prefix: PARKED });
      expect(s.branches.b2.status).toBe('parked');
      expect(s.currentBranchId).toBe('b1');
    });
    it('park on the root is a plain continue', () => {
      const s = createSession('s', 0);
      const r = applyDecision(s, d({ kind: 'park' }), 2);
      expect(r).toMatchObject({ branchId: 'b1', prefix: null, instruction: null });
      expect(r.skipReply).toBeFalsy();
    });
    it('scratch with something to scratch marks turns and skips the reply', () => {
      const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'oops', 1); appendTurn(s, 'b1', 'assistant', 'ok', 2);
      const r = applyDecision(s, d({ kind: 'scratch' }), 3);
      expect(r).toMatchObject({ prefix: SCRATCHED, skipReply: true });
      expect(s.turns.every((t) => t.scratched)).toBe(true);
    });
    it('scratch with nothing says go ahead', () => {
      const s = createSession('s', 0);
      expect(applyDecision(s, d({ kind: 'scratch' }), 3)).toMatchObject({ prefix: NOTHING_TO_SCRATCH, skipReply: true });
    });
    it('only-one-thread skips the reply', () => {
      const s = createSession('s', 0);
      expect(applyDecision(s, d({ kind: 'only-one-thread' }), 3)).toMatchObject({ prefix: ONLY_ONE_THREAD, skipReply: true });
    });
    it('recap lists up to three non-faded branches, most recent first', () => {
      const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'alpha idea', 1);
      forkBranch(s, 'b1', 'fork', 'live', 2); renameBranch(s, 'b2', 'Two'); appendTurn(s, 'b2', 'user', 'beta idea', 3);
      forkBranch(s, 'b1', 'fork', 'live', 4); renameBranch(s, 'b3', 'Three'); appendTurn(s, 'b3', 'user', 'gamma idea', 5);
      forkBranch(s, 'b1', 'fork', 'faded', 6); appendTurn(s, 'b4', 'user', 'faded one', 7);
      const r = applyDecision(s, d({ kind: 'recap' }), 8);
      expect(r.instruction).toBe(recapInstruction([
        { name: 'Three', lastLine: 'gamma idea' }, { name: 'Two', lastLine: 'beta idea' }, { name: 'Main', lastLine: 'alpha idea' },
      ]));
    });
    it('compare offers a merge once per pair', () => {
      const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'live', 1); renameBranch(s, 'b2', 'Two');
      const r1 = applyDecision(s, d({ kind: 'compare', otherId: 'b1' }), 2);
      expect(r1).toMatchObject({ branchId: 'b2', instruction: compareInstruction('Main', true) });
      expect(s.branches.b2.mergeOffered?.length).toBe(1);
      expect(applyDecision(s, d({ kind: 'compare', otherId: 'b1' }), 3).instruction).toBe(compareInstruction('Main', false));
    });
    it('merge creates a merged branch with the opening instruction', () => {
      const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'live', 1); renameBranch(s, 'b2', 'Two');
      const r = applyDecision(s, d({ kind: 'merge', otherId: 'b1' }), 2);
      expect(s.branches[r.branchId].origin).toBe('merge');
      expect(r.instruction).toBe(mergeOpeningInstruction('Two', 'Main'));
    });
    it('a fork at three live branches stays provisional and asks what to set aside', () => {
      const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'live', 1); forkBranch(s, 'b1', 'fork', 'live', 2);
      const r = applyDecision(s, d({ kind: 'fork', acknowledge: false }), 3);
      expect(s.branches[r.branchId].status).toBe('provisional');
      expect(s.awaitingSetAside).toEqual({ branchId: r.branchId, asked: 1 });
      expect(r.instruction).toBe(setAsideInstruction(['Main', 'New path', 'New path']));
    });
    const atLimit = () => {
      const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'live', 1); forkBranch(s, 'b1', 'fork', 'live', 2);
      applyDecision(s, d({ kind: 'fork', acknowledge: false }), 3);
      return s;
    };
    it('a confident target parks it and promotes the new branch', () => {
      const s = atLimit();
      const r = applyDecision(s, d({ kind: 'switch', targetId: 'b2' }), 4);
      expect(s.branches.b2.status).toBe('parked');
      expect(s.branches.b4.status).toBe('live');
      expect(r.branchId).toBe('b4');
      expect(s.awaitingSetAside).toBeUndefined();
    });
    it('ignoring the question keeps it provisional and does not ask again', () => {
      const s = atLimit();
      const r = applyDecision(s, d({ kind: 'continue' }), 4);
      expect(s.branches.b4.status).toBe('provisional');
      expect(s.awaitingSetAside?.asked).toBe(2);
      expect(r.instruction).toBeNull();
      expect(applyDecision(s, d({ kind: 'continue' }), 5).instruction).toBeNull();
      expect(s.branches.b4.status).toBe('provisional');
    });
    it('offers a parked branch back once after three continues on its parent', () => {
      const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'live', 1); renameBranch(s, 'b2', 'Podcast');
      applyDecision(s, d({ kind: 'park' }), 2);
      expect(applyDecision(s, d({ kind: 'continue' }), 3).instruction).toBeNull();
      expect(applyDecision(s, d({ kind: 'continue' }), 4).instruction).toBeNull();
      expect(applyDecision(s, d({ kind: 'continue' }), 5).instruction).toBe(parkedReminderInstruction('Podcast'));
      expect(s.branches.b2.offeredBack).toBe(true);
      for (let i = 0; i < 4; i++) expect(applyDecision(s, d({ kind: 'continue' }), 6 + i).instruction).toBeNull();
    });
    it('a non-continue op resets the streak', () => {
      const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'live', 1); setStatus(s, 'b2', 'parked', 2); s.currentBranchId = 'b1';
      applyDecision(s, d({ kind: 'continue' }), 3); applyDecision(s, d({ kind: 'continue' }), 4);
      applyDecision(s, d({ kind: 'recap' }), 5);
      expect(applyDecision(s, d({ kind: 'continue' }), 6).instruction).toBeNull();
    });
  });
});
