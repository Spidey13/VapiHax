import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { appendTurn, createSession, forkBranch, mergeBranches, renameBranch } from '../src/tree/tree.js';
import { buildContext } from '../src/tree/context.js';
import { applyDecision } from '../src/turn/apply.js';
import { runTurn } from '../src/turn/pipeline.js';
import { decide } from '../src/route/policy.js';
import { TraceStore } from '../src/trace.js';
import { NOTHING_YET, PARKED, SCRATCHED, SET_ASIDE, switchConfirm } from '../src/reply/copy.js';
import { askMergeInstruction, setAsideInstruction } from '../src/reply/prompts.js';
import type { Op, RawAnswers, RouteDecision, RouteInput } from '../src/route/types.js';
import type { Responder } from '../src/reply/responder.js';
import { fakeDigester, fakeNamer, fakeResponder, fakeRouter, slowResponder } from './helpers/fakes.js';

const d = (op: Op, takesUp?: number): RouteDecision => ({
  op, intent: null, by: 'jev', ms: 1, reason: '',
  ...(takesUp !== undefined ? { raw: { intent: { choice: 'continue', confidence: 0.9 }, target: { choice: 'none', confidence: 0 }, detailNotDirection: 0, takesUpSuggestion: takesUp } as RawAnswers } : {}),
});
const tick = () => new Promise((res) => setTimeout(res, 0));
const deps = (responder: Responder, router = fakeRouter()) => ({ router, responder, namer: fakeNamer(null), traces: new TraceStore() });
const live = (s: ReturnType<typeof createSession>) => Object.values(s.branches).filter((b) => b.status === 'live' || b.status === 'provisional');

describe('C1 merge digests persist', () => {
  it('stored on the merged branch and used by every later buildContext', async () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'start', 1); forkBranch(s, 'b1', 'fork', 'live', 2); appendTurn(s, 'b2', 'user', 'idea', 3);
    const seen: string[][] = [];
    const responder: Responder = { async *reply(req) { seen.push(req.context.notes); yield 'Ok.'; } };
    await runTurn({ ...deps(responder, fakeRouter({ kind: 'merge', otherId: 'b1' })), digester: fakeDigester('DIG') }, s, 'combine');
    await runTurn(deps(responder), s, 'and then?');
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[1].some((n) => n.includes('DIG'))).toBe(true);
  });
  it('buildContext appends mergeDigests for a merged branch', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'x', 1); forkBranch(s, 'b1', 'fork', 'live', 2); forkBranch(s, 'b1', 'fork', 'live', 3);
    const m = mergeBranches(s, 'b2', 'b3', 4); m.mergeDigests = ['n1'];
    expect(buildContext(s, m.id).notes).toEqual(['n1']);
    expect(buildContext(s, m.id, ['compare-note']).notes).toEqual(['n1', 'compare-note']);
  });
});

describe('I1 accepting the merge offer', () => {
  const afterCompare = () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1); forkBranch(s, 'b1', 'fork', 'live', 2); appendTurn(s, 'b2', 'user', 'b', 3);
    applyDecision(s, d({ kind: 'compare', otherId: 'b1' }), 4);
    return s;
  };
  const originAfter = (dec: RouteDecision, text = 'sure, do it') => { const s = afterCompare(); return s.branches[applyDecision(s, dec, 5, text).branchId]; };
  it('records the pair when the offer is made', () => {
    expect(afterCompare().pendingMergeOffer).toEqual({ a: 'b2', b: 'b1' });
  });
  it('a yes-answered fork merges the remembered pair', () => {
    const s = afterCompare();
    const r = applyDecision(s, d({ kind: 'fork', acknowledge: false }), 5, 'yes please');
    expect(s.branches[r.branchId]).toMatchObject({ origin: 'merge', mergedFrom: ['b2', 'b1'] });
    expect(s.pendingMergeOffer).toBeUndefined();
  });
  it('a yes continue merges; a merge with no confident target merges', () => {
    expect(originAfter(d({ kind: 'continue' })).origin).toBe('merge');
    expect(originAfter(d({ kind: 'ask-merge' })).origin).toBe('merge');
  });
  it('an unrelated continue merges nothing and clears the offer', () => {
    const s = afterCompare();
    const r = applyDecision(s, d({ kind: 'continue' }), 5, 'what about the venue');
    expect(s.branches[r.branchId].origin).not.toBe('merge');
    expect(s.pendingMergeOffer).toBeUndefined();
  });
  it('a rolled-back turn restores the pending offer', async () => {
    const s = afterCompare();
    const ac = new AbortController();
    const r = runTurn(deps(slowResponder(), fakeRouter({ kind: 'continue' })), s, 'hmm', { signal: ac.signal });
    await tick(); await tick(); ac.abort(); await r;
    expect(s.pendingMergeOffer).toEqual({ a: 'b2', b: 'b1' });
  });
});

describe('I2 unclear merge', () => {
  const three = (): RouteInput => ({ utterance: 'combine', current: { id: 'b1', name: 'A', summary: '', provisional: false, lastUser: 'x', lastAssistant: null }, others: [{ id: 'b2', name: 'B', summary: '' }, { id: 'b3', name: 'C', summary: '' }] });
  it('policy returns ask-merge for several others and no confident target', () => {
    const raw: RawAnswers = { intent: { choice: 'merge', confidence: 0.9 }, target: { choice: 'none', confidence: 0.9 }, detailNotDirection: 0, takesUpSuggestion: 0 };
    expect(decide(raw, three()).op).toEqual({ kind: 'ask-merge' });
  });
  const setup = () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); renameBranch(s, 'b2', 'Two'); s.currentBranchId = 'b1';
    forkBranch(s, 'b1', 'fork', 'live', 3); renameBranch(s, 'b3', 'Three'); s.currentBranchId = 'b1';
    return s;
  };
  it('asks a merge-specific question and the confident answer merges', () => {
    const s = setup();
    const r = applyDecision(s, d({ kind: 'ask-merge' }), 4);
    expect(r.instruction).toBe(askMergeInstruction(['Three', 'Two']));
    expect(r.branchId).toBe('b1');
    expect(s.pendingMerge).toBe(true);
    const r2 = applyDecision(s, d({ kind: 'switch', targetId: 'b2' }), 5);
    expect(s.branches[r2.branchId]).toMatchObject({ origin: 'merge', mergedFrom: ['b1', 'b2'] });
    expect(s.pendingMerge).toBeUndefined();
  });
  it('is cleared after one turn', () => {
    const s = setup();
    applyDecision(s, d({ kind: 'ask-merge' }), 4);
    applyDecision(s, d({ kind: 'continue' }), 5);
    expect(s.pendingMerge).toBeUndefined();
    expect(applyDecision(s, d({ kind: 'switch', targetId: 'b2' }), 6).branchId).toBe('b2');
  });
  it('a rolled-back turn restores pendingMerge', async () => {
    const s = setup(); applyDecision(s, d({ kind: 'ask-merge' }), 4);
    const ac = new AbortController();
    const r = runTurn(deps(slowResponder(), fakeRouter({ kind: 'continue' })), s, 'hmm', { signal: ac.signal });
    await tick(); await tick(); ac.abort(); await r;
    expect(s.pendingMerge).toBe(true);
  });
});

describe('I3 set-aside answers', () => {
  const atLimit = () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); s.currentBranchId = 'b1'; forkBranch(s, 'b1', 'fork', 'live', 3); s.currentBranchId = 'b1';
    applyDecision(s, d({ kind: 'fork', acknowledge: false }), 4);
    return s; // b4 provisional, awaiting
  };
  it('policy carries a confident park target', () => {
    const input: RouteInput = { utterance: 'park the podcast', current: { id: 'b1', name: 'A', summary: '', provisional: false, lastUser: 'x', lastAssistant: null }, others: [{ id: 'b2', name: 'B', summary: '' }] };
    const raw = (t: string, c: number): RawAnswers => ({ intent: { choice: 'park', confidence: 0.9 }, target: { choice: t, confidence: c }, detailNotDirection: 0, takesUpSuggestion: 0 });
    expect(decide(raw('b2', 0.8), input).op).toEqual({ kind: 'park', targetId: 'b2' });
    expect(decide(raw('none', 0.9), input).op).toEqual({ kind: 'park' });
  });
  it('a park with a confident other target parks it and promotes the new branch', () => {
    const s = atLimit();
    const r = applyDecision(s, d({ kind: 'park', targetId: 'b2' }), 5);
    expect(s.branches.b2.status).toBe('parked');
    expect(s.branches.b4.status).toBe('live');
    expect(r).toMatchObject({ branchId: 'b4', prefix: PARKED });
  });
  it('a switch to the parent drops the new idea', () => {
    const s = atLimit();
    const r = applyDecision(s, d({ kind: 'switch', targetId: 'b1' }), 5);
    expect(s.branches.b4.status).toBe('faded');
    expect(s.branches.b1.status).toBe('live');
    expect(r.branchId).toBe('b1');
    expect(s.awaitingSetAside).toBeUndefined();
  });
  it('a switch to another live branch still parks it', () => {
    const s = atLimit();
    applyDecision(s, d({ kind: 'switch', targetId: 'b2' }), 5);
    expect(s.branches.b2.status).toBe('parked');
    expect(s.currentBranchId).toBe('b4');
  });
});

describe('I4 live limit on every path', () => {
  const four = () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); renameBranch(s, 'b2', 'Two'); s.currentBranchId = 'b1';
    forkBranch(s, 'b1', 'fork', 'live', 3); renameBranch(s, 'b3', 'Three'); s.currentBranchId = 'b1';
    forkBranch(s, 'b1', 'fork', 'parked', 4); renameBranch(s, 'b4', 'Four'); s.currentBranchId = 'b1';
    s.branches.b2.lastActiveAt = 10; s.branches.b3.lastActiveAt = 20; s.branches.b1.lastActiveAt = 30;
    return s;
  };
  it('switching to a parked branch auto-parks the least recently active other', () => {
    const s = four();
    const r = applyDecision(s, d({ kind: 'switch', targetId: 'b4' }), 40);
    expect(s.branches.b2.status).toBe('parked');
    expect(live(s)).toHaveLength(3);
    expect(r.prefix).toBe(`${SET_ASIDE('Two')} ${switchConfirm('Four')}`);
  });
  it('never parks the branch it left', () => {
    const s = four(); s.branches.b1.lastActiveAt = 1;
    applyDecision(s, d({ kind: 'switch', targetId: 'b4' }), 40);
    expect(s.branches.b1.status).toBe('live');
    expect(s.branches.b2.status).toBe('parked');
  });
  it('a correct while a set-aside is pending keeps the question open on the correction branch', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); s.currentBranchId = 'b1'; forkBranch(s, 'b1', 'fork', 'live', 3); s.currentBranchId = 'b1';
    applyDecision(s, d({ kind: 'fork', acknowledge: false }), 4);
    appendTurn(s, 'b4', 'user', 'new idea', 5);
    const r = applyDecision(s, d({ kind: 'correct' }), 6);
    expect(live(s).filter((b) => b.status === 'live')).toHaveLength(3); // not promoted to a fourth live branch
    expect(s.branches.b4.status).toBe('faded');
    expect(s.branches[r.branchId].status).toBe('provisional');
    expect(s.awaitingSetAside).toEqual({ branchId: r.branchId, asked: 2 });
  });
  it('the tap-switch route auto-parks too', async () => {
    const { createApp, defaultDeps } = await import('../src/server.js');
    const dd = defaultDeps({ router: fakeRouter(), responder: fakeResponder(['x']), namer: fakeNamer(null) });
    const app = createApp(dd);
    const created = await request(app).post('/api/sessions').expect(201);
    const s = dd.sessions.get(created.body.sessionId)!;
    Object.assign(s, four(), { id: s.id, lastActivity: Date.now() });
    await request(app).post(`/api/sessions/${s.id}/switch`).set('authorization', `Bearer ${created.body.token}`).send({ branchId: 'b4' }).expect(200);
    expect(live(s)).toHaveLength(3);
    expect(s.branches.b2.status).toBe('parked');
  });
});

describe('I5 scratching the fork-creating utterance', () => {
  it('fades a fork and returns to the parent', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    const r0 = applyDecision(s, d({ kind: 'fork', acknowledge: false }), 2); appendTurn(s, r0.branchId, 'user', 'side idea', 3); appendTurn(s, r0.branchId, 'assistant', 'ok', 4);
    const r = applyDecision(s, d({ kind: 'scratch' }), 5);
    expect(s.branches.b2.status).toBe('faded');
    expect(r).toMatchObject({ branchId: 'b1', prefix: SCRATCHED });
    expect(s.currentBranchId).toBe('b1');
  });
  it('fades a correction branch and revives the replaced one', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'three', 1);
    const r0 = applyDecision(s, d({ kind: 'correct' }), 2); appendTurn(s, r0.branchId, 'user', 'four', 3, 'correction');
    expect(s.branches.b1.status).toBe('faded');
    applyDecision(s, d({ kind: 'scratch' }), 4);
    expect(s.branches.b2.status).toBe('faded');
    expect(s.branches.b1.status).toBe('live');
    expect(s.currentBranchId).toBe('b1');
  });
  it('leaves a branch that still has turns alone', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    const r0 = applyDecision(s, d({ kind: 'fork', acknowledge: false }), 2); appendTurn(s, r0.branchId, 'user', 'one', 3); appendTurn(s, r0.branchId, 'user', 'two', 4);
    applyDecision(s, d({ kind: 'scratch' }), 5);
    expect(s.currentBranchId).toBe('b2');
    expect(s.branches.b2.status).not.toBe('faded');
  });
});

describe('M1 reply kinds', () => {
  it('marks merge-opening, recap and compare assistant turns', async () => {
    const mk = () => { const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1); forkBranch(s, 'b1', 'fork', 'live', 2); appendTurn(s, 'b2', 'user', 'b', 3); return s; };
    const kindOf = async (op: Op) => { const s = mk(); await runTurn(deps(fakeResponder(['Ok.']), fakeRouter(op)), s, 'x'); return s.turns.at(-1)!.kind; };
    expect(await kindOf({ kind: 'recap' })).toBe('recap');
    expect(await kindOf({ kind: 'compare', otherId: 'b1' })).toBe('compare');
    expect(await kindOf({ kind: 'merge', otherId: 'b1' })).toBe('merge-opening');
    expect(await kindOf({ kind: 'continue' })).toBeUndefined();
  });
});

describe('M4 set-aside names', () => {
  it('uses the last user line for an unnamed branch', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); appendTurn(s, 'b2', 'user', 'what about a podcast with weekly guests instead', 3);
    s.currentBranchId = 'b1'; forkBranch(s, 'b1', 'fork', 'live', 4); renameBranch(s, 'b3', 'Named'); s.currentBranchId = 'b1';
    const r = applyDecision(s, d({ kind: 'fork', acknowledge: false }), 5);
    expect(r.instruction).toBe(setAsideInstruction(['Main', 'what about a podcast with weekly', 'Named']));
  });
});

describe('M5 recap before any user turn', () => {
  it('answers with a fixed line and skips the reply', () => {
    const s = createSession('s', 0);
    expect(applyDecision(s, d({ kind: 'recap' }), 1)).toMatchObject({ prefix: NOTHING_YET, skipReply: true, instruction: null });
  });
});

describe('fix-wave A follow-ups', () => {
  const limitSession = () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); renameBranch(s, 'b2', 'Two'); s.currentBranchId = 'b1';
    forkBranch(s, 'b1', 'fork', 'live', 3); renameBranch(s, 'b3', 'Three'); s.currentBranchId = 'b1';
    forkBranch(s, 'b1', 'fork', 'parked', 4); renameBranch(s, 'b4', 'Four'); s.currentBranchId = 'b1';
    s.branches.b2.lastActiveAt = 10; s.branches.b3.lastActiveAt = 20; s.branches.b1.lastActiveAt = 30;
    return s;
  };
  it('1: 3 live + 1 provisional + switch to a parked branch parks two, announced in order', () => {
    const s = limitSession();
    const r0 = applyDecision(s, d({ kind: 'fork', acknowledge: false }), 5); // b5 provisional, set-aside pending
    expect(s.branches[r0.branchId].status).toBe('provisional');
    const r = applyDecision(s, d({ kind: 'switch', targetId: 'b4' }), 40);
    expect(live(s)).toHaveLength(3);
    expect(s.branches.b2.status).toBe('parked');
    expect(s.branches.b3.status).toBe('parked');
    expect(r.prefix).toBe(`${SET_ASIDE('Two')} ${SET_ASIDE('Three')} ${switchConfirm('Four')}`);
  });
  it('1: switching to an already-live branch with a set-aside pending parks nothing', async () => {
    const { createApp, defaultDeps } = await import('../src/server.js');
    const dd = defaultDeps({ router: fakeRouter(), responder: fakeResponder(['x']), namer: fakeNamer(null) });
    const app = createApp(dd);
    const created = await request(app).post('/api/sessions').expect(201);
    const s = dd.sessions.get(created.body.sessionId)!;
    const t = limitSession(); setStatusLive(t);
    applyDecision(t, d({ kind: 'fork', acknowledge: false }), 5);
    Object.assign(s, t, { id: s.id, lastActivity: Date.now() });
    const before = Object.values(s.branches).map((b) => b.status);
    await request(app).post(`/api/sessions/${s.id}/switch`).set('authorization', `Bearer ${created.body.token}`).send({ branchId: 'b2' }).expect(200);
    expect(Object.values(s.branches).map((b) => b.status)).toEqual(before);
    function setStatusLive(x: typeof t) { x.branches.b4.status = 'faded'; }
  });
  it('2: a merge op with a confident target outside the remembered pair wins', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); s.currentBranchId = 'b1'; forkBranch(s, 'b1', 'fork', 'live', 3); s.currentBranchId = 'b2';
    appendTurn(s, 'b2', 'user', 'b', 4);
    applyDecision(s, d({ kind: 'compare', otherId: 'b1' }), 5);
    const r = applyDecision(s, d({ kind: 'merge', otherId: 'b3' }, 0.9), 6);
    expect(s.branches[r.branchId].mergedFrom).toEqual(['b2', 'b3']);
  });
  it('3: scratching a fork whose parent is faded stays on the branch', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    const r0 = applyDecision(s, d({ kind: 'fork', acknowledge: false }), 2); appendTurn(s, r0.branchId, 'user', 'side', 3);
    s.branches.b1.status = 'faded';
    const r = applyDecision(s, d({ kind: 'scratch' }), 4);
    expect(r.branchId).toBe('b2');
    expect(s.branches.b2.status).not.toBe('faded');
    expect(s.currentBranchId).toBe('b2');
  });
  it('5: a park with a confident other target parks it and stays', () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); s.currentBranchId = 'b1'; forkBranch(s, 'b1', 'fork', 'live', 3);
    const r = applyDecision(s, d({ kind: 'park', targetId: 'b2' }), 4);
    expect(s.branches.b2.status).toBe('parked');
    expect(s.currentBranchId).toBe('b3');
    expect(r).toMatchObject({ branchId: 'b3', prefix: PARKED });
    // also from the root
    const t = createSession('t', 0); appendTurn(t, 'b1', 'user', 'a', 1); forkBranch(t, 'b1', 'fork', 'live', 2); t.currentBranchId = 'b1';
    const r2 = applyDecision(t, d({ kind: 'park', targetId: 'b2' }), 3);
    expect(t.branches.b2.status).toBe('parked');
    expect(r2).toMatchObject({ branchId: 'b1', prefix: PARKED });
  });
});

describe('I1 plain yes accepts a pending merge offer', () => {
  const afterCompare = () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'a', 1); forkBranch(s, 'b1', 'fork', 'live', 2); appendTurn(s, 'b2', 'user', 'b', 3);
    applyDecision(s, d({ kind: 'compare', otherId: 'b1' }), 4);
    return s;
  };
  const originFor = (utterance: string, op: Op, offer = true) => {
    const s = offer ? afterCompare() : createSession('s', 0);
    if (!offer) { appendTurn(s, 'b1', 'user', 'a', 1); forkBranch(s, 'b1', 'fork', 'live', 2); appendTurn(s, 'b2', 'user', 'b', 3); }
    return s.branches[applyDecision(s, d(op), 5, utterance).branchId].origin;
  };
  for (const u of ['Sure, do it.', 'Yes please', 'yeah, combine them']) {
    it(`"${u}" merges on a continue`, () => expect(originFor(u, { kind: 'continue' })).toBe('merge'));
    it(`"${u}" merges on a fork`, () => expect(originFor(u, { kind: 'fork', acknowledge: false })).toBe('merge'));
  }
  it('a long affirmative-led utterance is not a plain yes', () =>
    expect(originFor('yes, and what about the budget for the venue', { kind: 'continue' })).not.toBe('merge'));
  it('a non-affirmative short utterance does not merge', () =>
    expect(originFor('what about food', { kind: 'continue' })).not.toBe('merge'));
  it('without a pending offer a plain yes merges nothing', () =>
    expect(originFor('Sure, do it.', { kind: 'continue' }, false)).not.toBe('merge'));
});
