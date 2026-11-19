import { describe, expect, it, vi } from 'vitest';
import { appendTurn, createSession, forkBranch, pathTurns, renameBranch } from '../src/tree/tree.js';
import { DIGEST_WAIT_MS, FILLER_AFTER_FILLER_DELAY_MS, REPLY_DEADLINE_MS, runTurn } from '../src/turn/pipeline.js';
import { TraceStore } from '../src/trace.js';
import { FORK_ACK, REPLY_ERROR } from '../src/reply/copy.js';
import { ReplyTruncatedError, type Responder } from '../src/reply/responder.js';
import { FILLERS, FillerPicker } from '../src/reply/filler.js';
import { mergeNamePrompt } from '../src/reply/namer.js';
import type { Turn } from '../src/tree/types.js';
import { fakeDigester, fakeNamer, fakeResponder, fakeRouter, gatedResponder, slowResponder } from './helpers/fakes.js';
import { correctedMergedPlan, correctedTrip } from './helpers/voiceScenarios.js';

const tick = () => new Promise((res) => setTimeout(res, 0));

const deps = (responder: Responder) => ({ router: fakeRouter(), responder, namer: fakeNamer(null), traces: new TraceStore() });

describe('runTurn', () => {
  it('emits sentences as they complete', async () => {
    const s = createSession('s', 0);
    const got: string[] = [];
    await runTurn(deps(fakeResponder(['One. Tw', 'o. Three'])), s, 'hi', { onSentence: (x) => got.push(x) });
    expect(got).toEqual(['One.', 'Two.', 'Three']);
  });
  it('an abort before any sentence rolls the whole turn back (no turns, no branch) and keeps revision monotonic', async () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'earlier', 1);
    const before = { revision: s.revision, turns: structuredClone(s.turns), counters: { ...s.counters } };
    const ac = new AbortController();
    const got: string[] = [];
    const namer = { name: vi.fn(async () => 'Never') };
    const d = { ...deps(slowResponder()), router: fakeRouter({ kind: 'fork', acknowledge: false }), namer };
    const r = runTurn(d, s, 'hi', { signal: ac.signal, onSentence: (x) => got.push(x) });
    await tick();
    await tick();
    ac.abort();
    const res = await r;
    expect(got).toEqual([]);
    expect(res.reply).toBe('');
    expect(s.turns).toEqual(before.turns);
    expect(Object.keys(s.branches)).toEqual(['b1']);
    expect(s.currentBranchId).toBe('b1');
    expect(s.counters).toEqual(before.counters);
    expect(s.revision).toBeGreaterThan(before.revision);
    expect(namer.name).not.toHaveBeenCalled();
  });
  it('an abort while routing leaves the session untouched', async () => {
    const s = createSession('s', 0);
    const ac = new AbortController();
    const router = { async route() { ac.abort(); return { op: { kind: 'fork' as const, acknowledge: false }, intent: null, by: 'jev' as const, ms: 1, reason: '' }; } };
    await runTurn({ ...deps(fakeResponder(['Hi.'])), router }, s, 'hi', { signal: ac.signal });
    expect(s.turns).toEqual([]);
    expect(Object.keys(s.branches)).toEqual(['b1']);
    expect(s.revision).toBe(0);
  });
  it('an abort then a resent combined text yields exactly one user turn', async () => {
    const s = createSession('s', 0);
    const ac = new AbortController();
    const r = runTurn({ ...deps(slowResponder()), router: fakeRouter({ kind: 'fork', acknowledge: false }) }, s, 'so', { signal: ac.signal });
    await tick();
    await tick();
    ac.abort();
    await r;
    await runTurn(deps(fakeResponder(['Ok.'])), s, 'so the newsletter');
    expect(s.turns.filter((t) => t.role === 'user').map((t) => t.text)).toEqual(['so the newsletter']);
    expect(Object.keys(s.branches)).toEqual(['b1']);
  });
  it('records routeMs 0 when the decision was supplied (speculation hit)', async () => {
    const s = createSession('s', 0);
    const d = deps(fakeResponder(['Ok.']));
    await runTurn(d, s, 'hi', { decision: { op: { kind: 'continue' }, intent: 'continue', by: 'jev', ms: 7, reason: 'speculated' } });
    expect(d.traces.list('s')[0]!.routeMs).toBe(0);
  });
  it('an abort after the first sentence records exactly that sentence', async () => {
    const s = createSession('s', 0);
    const ac = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const got: string[] = [];
    const r = await runTurn(deps(gatedResponder(['First. Sec'], gate, ['ond.'])), s, 'hi', {
      signal: ac.signal,
      onSentence: (x) => {
        got.push(x);
        setTimeout(() => ac.abort(), 0); // the interrupt lands after delivery, while the model is blocked
      },
    });
    release();
    expect(got).toEqual(['First.']);
    expect(r.reply).toBe('First.');
    expect(s.turns.map((t) => t.text)).toEqual(['hi', 'First.']);
  });
  it('uses a supplied decision instead of routing', async () => {
    const s = createSession('s', 0);
    const router = { route: vi.fn() };
    await runTurn({ ...deps(fakeResponder(['Ok.'])), router }, s, 'hi', { decision: { op: { kind: 'continue' }, intent: 'continue', by: 'jev', ms: 0, reason: 'speculated' } });
    expect(router.route).not.toHaveBeenCalled();
  });
  it('records the user turn on the routed branch and the streamed reply after the prefix', async () => {
    const s = createSession('s', 0);
    const deps = { router: fakeRouter({ kind: 'fork', acknowledge: true }), responder: fakeResponder(['Then ', 'guests matter.']), namer: fakeNamer('Podcast'), traces: new TraceStore() };
    const chunks: string[] = [];
    const r = await runTurn(deps, s, 'or a podcast?', { onSentence: (c) => chunks.push(c) });
    expect(r.branchId).toBe('b2');
    expect(r.reply).toBe(`${FORK_ACK} Then guests matter.`);
    expect(chunks.join(' ')).toBe(r.reply);
    expect(pathTurns(s, 'b2').map((t) => [t.role, t.text])).toEqual([['user', 'or a podcast?'], ['assistant', r.reply]]);
    await tick();
    expect(s.branches.b2.name).toBe('Podcast');
  });
  it('names the root from its own words at its first fork (spoken as "Back to Main." before)', async () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'a nice restaurant for twenty', 1);
    const name = async (t: string) => (t.includes('restaurant') ? 'Restaurant dinner' : 'Backyard barbecue');
    await runTurn({ ...deps(fakeResponder(['Ok.'])), router: fakeRouter({ kind: 'fork', acknowledge: false }), namer: { name } }, s, 'or a backyard barbecue?');
    await tick();
    expect([s.branches.b1.name, s.branches.b2.name]).toEqual(['Restaurant dinner', 'Backyard barbecue']);
  });
  it('leaves the placeholder name when the namer returns null', async () => {
    const s = createSession('s', 0);
    const deps = { router: fakeRouter({ kind: 'fork', acknowledge: false }), responder: fakeResponder(['Ok.']), namer: fakeNamer(null), traces: new TraceStore() };
    await runTurn(deps, s, 'or a podcast?');
    await tick();
    expect(s.branches.b2.name).toBe('New path');
  });
  it('marks the user turn of a correction', async () => {
    const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'three people', 1);
    const deps = { router: fakeRouter({ kind: 'correct' }), responder: fakeResponder(['Okay.']), namer: fakeNamer(null), traces: new TraceStore() };
    const r = await runTurn(deps, s, 'four people actually');
    expect(pathTurns(s, r.branchId).at(-2)).toMatchObject({ text: 'four people actually', kind: 'correction' });
  });
  it('replies with the fixed error line when the model fails before any text', async () => {
    const s = createSession('s', 0);
    const deps = { router: fakeRouter(), responder: fakeResponder(new Error('down')), namer: fakeNamer(null), traces: new TraceStore() };
    const chunks: string[] = [];
    const r = await runTurn(deps, s, 'hello', { onSentence: (c) => chunks.push(c) });
    expect(r.reply).toBe(REPLY_ERROR);
    expect(r.failed).toBe(true);
    expect(chunks).toEqual([REPLY_ERROR]);
    expect(s.turns.map((t) => t.text)).toEqual([]); // spoken, never stored; the plain continue is rolled back
  });
  it('treats a stream that ends with no text as a failure before any text', async () => {
    const s = createSession('s', 0);
    const deps = { router: fakeRouter(), responder: fakeResponder([]), namer: fakeNamer(null), traces: new TraceStore() };
    const chunks: string[] = [];
    const r = await runTurn(deps, s, 'hello', { onSentence: (c) => chunks.push(c) });
    expect(r.reply).toBe(REPLY_ERROR);
    expect(r.failed).toBe(true);
    expect(chunks).toEqual([REPLY_ERROR]);
    expect(s.turns.map((t) => t.text)).toEqual([]); // spoken, never stored; the plain continue is rolled back
  });
  it('a refused compare keeps the merge offer; a refused merge keeps the merged branch and both digests, records no reply, and the next reply sees both digests', async () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'a trip to Japan', 1); appendTurn(s, 'b1', 'assistant', 'Sounds good.', 2);
    const f = forkBranch(s, 'b1', 'fork', 'live', 3);
    appendTurn(s, f.id, 'user', 'Hokkaido, Furano, ryokan', 4); appendTurn(s, f.id, 'assistant', 'Lovely.', 5);
    s.currentBranchId = 'b1';
    const refuse = (): Responder => ({ async *reply() { throw new ReplyTruncatedError('refusal'); } });
    const seen: string[][] = [];
    const ok: Responder = { async *reply(req) { seen.push(req.context.notes); yield 'Fine.'; } };
    let call = 0;
    const responder: Responder = { reply: (req, signal) => (++call <= 2 ? refuse() : ok).reply(req, signal) };
    const d = { ...deps(responder), digester: fakeDigester((n) => `DIGEST-${n}`), router: fakeRouter({ kind: 'compare', otherId: f.id }, { kind: 'merge', otherId: f.id }, { kind: 'continue' }) };

    const r1 = await runTurn(d, s, 'compare them');
    expect(r1.failed).toBe(true);
    expect(s.turns.some((t) => t.role === 'assistant' && t.text === REPLY_ERROR)).toBe(false);
    expect(s.pendingMergeOffer).toBeUndefined(); // no merge was offered in words, so none is pending...
    expect(s.branches.b1.mergeOffered ?? []).toEqual([]); // ...and the offer is not marked as already made

    const r2 = await runTurn(d, s, 'combine them');
    expect(r2.failed).toBe(true);
    const merged = Object.values(s.branches).find((b) => b.mergedFrom)!;
    expect(s.currentBranchId).toBe(merged.id);
    expect(merged.mergeDigests).toEqual(['Thread "Main": DIGEST-Main', `Thread "${s.branches[f.id].name}": DIGEST-${s.branches[f.id].name}`]);
    expect(pathTurns(s, merged.id).filter((t) => t.role === 'assistant' && t.text === REPLY_ERROR)).toEqual([]);
    expect(s.turns.filter((t) => t.branchId === merged.id).map((t) => t.role)).toEqual(['user']);

    await runTurn(d, s, 'so what now?');
    expect(seen[0]).toEqual(expect.arrayContaining([expect.stringContaining('DIGEST-Main'), expect.stringContaining(`DIGEST-${s.branches[f.id].name}`)]));
  });
  it('keeps a finished sentence but not a broken fragment when the model fails mid-reply', async () => {
    const s = createSession('s', 0);
    const deps = { router: fakeRouter(), responder: fakeResponder(['Half a ', 'thought'], 1), namer: fakeNamer(null), traces: new TraceStore() };
    const failed = await runTurn(deps, s, 'hello');
    expect(failed.reply).toBe(REPLY_ERROR); // no complete sentence: the error line once
    expect(failed.failed).toBe(true);
    const s2 = createSession('s2', 0);
    const d2 = { router: fakeRouter(), responder: fakeResponder(['A whole one. ', 'thought'], 1), namer: fakeNamer(null), traces: new TraceStore() };
    expect((await runTurn(d2, s2, 'hello')).reply).toBe('A whole one.');
  });
  it('does not rename a branch that was not forked, and records a trace', async () => {
    const s = createSession('s', 0);
    const traces = new TraceStore();
    await runTurn({ router: fakeRouter(), responder: fakeResponder(['Hm.']), namer: fakeNamer('X'), traces }, s, 'hi');
    await tick();
    expect(s.branches.b1.name).toBe('Main');
    expect(traces.list('s').at(-1)).toMatchObject({ routeBy: 'jev', op: 'continue' });
  });

  describe('filler', () => {
    const delayed = (ms: number, chunks: string[]): Responder => ({
      async *reply() {
        await new Promise((res) => setTimeout(res, ms));
        yield* chunks;
      },
    });
    const fdeps = (responder: Responder, router = fakeRouter()) => ({ ...deps(responder), router, filler: new FillerPicker(() => 0) });

    it('emits a filler first when the first delta is slow, and records only the reply', async () => {
      vi.useFakeTimers();
      try {
        const s = createSession('s', 0);
        const d = fdeps(delayed(300, ['Real answer.']));
        const got: string[] = [];
        const p = runTurn(d, s, 'hi', { onSentence: (x) => got.push(x) });
        await vi.advanceTimersByTimeAsync(300);
        const r = await p;
        expect(FILLERS).toContain(got[0]!);
        expect(got[0]).toBe(FILLERS[0]); // no trailing-space workaround: the SSE writer frames it with a flush tag
        expect(got.slice(1)).toEqual(['Real answer.']);
        expect(r.reply).toBe('Real answer.');
        expect(s.turns.map((t) => t.text)).toEqual(['hi', 'Real answer.']);
        const tr = d.traces.list('s')[0];
        expect(tr.filler).toBe(true);
        expect(tr.fillerAt).toBeDefined();
        expect(tr.firstSentenceAt).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });
    it('no filler when the first delta is fast, and no timer is left running', async () => {
      vi.useFakeTimers();
      try {
        const s = createSession('s', 0);
        const d = fdeps(delayed(10, ['Quick.']));
        const got: string[] = [];
        const p = runTurn(d, s, 'hi', { onSentence: (x) => got.push(x) });
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(got).toEqual(['Quick.']);
        expect(d.traces.list('s')[0].filler).toBeUndefined();
        expect(d.traces.list('s')[0].fillerAt).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
    it('no filler when there is a fork-ack prefix, even if slow', async () => {
      vi.useFakeTimers();
      try {
        const s = createSession('s', 0);
        const d = fdeps(delayed(400, ['Then guests.']), fakeRouter({ kind: 'fork', acknowledge: true }));
        const got: string[] = [];
        const p = runTurn(d, s, 'or a podcast?', { onSentence: (x) => got.push(x) });
        await vi.advanceTimersByTimeAsync(400);
        await p;
        expect(got).toEqual([FORK_ACK, 'Then guests.']);
        expect(d.traces.list('s')[0].filler).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
    it('an abort clears the timer and emits no filler', async () => {
      vi.useFakeTimers();
      try {
        const s = createSession('s', 0);
        const ac = new AbortController();
        const got: string[] = [];
        const p = runTurn(fdeps(slowResponder()), s, 'hi', { signal: ac.signal, onSentence: (x) => got.push(x) });
        ac.abort();
        await p;
        await vi.advanceTimersByTimeAsync(1000);
        expect(got).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('filler alternation', () => {
    const delayed = (ms: number, chunks: string[]): Responder => ({
      async *reply() {
        await new Promise((res) => setTimeout(res, ms));
        yield* chunks;
      },
    });
    const fdeps = (responder: Responder) => ({ ...deps(responder), filler: new FillerPicker(() => 0) });

    it('after a filler turn, the next ordinary turn delays its filler to FILLER_AFTER_FILLER_DELAY_MS instead of skipping it', async () => {
      vi.useFakeTimers();
      try {
        const s = createSession('s', 0);
        const d = fdeps(delayed(3000, ['Real.']));
        const first: string[] = [];
        const p1 = runTurn(d, s, 'one', { onSentence: (x) => first.push(x) });
        await vi.advanceTimersByTimeAsync(3000);
        await p1;
        expect(first[0]).toBe(FILLERS[0]);
        const second: string[] = [];
        const p2 = runTurn(d, s, 'two', { onSentence: (x) => second.push(x) });
        await vi.advanceTimersByTimeAsync(FILLER_AFTER_FILLER_DELAY_MS - 100);
        expect(second).toEqual([]); // not at 250 ms
        await vi.advanceTimersByTimeAsync(100);
        expect(second).toHaveLength(1); // at FILLER_AFTER_FILLER_DELAY_MS
        expect(FILLERS).toContain(second[0]);
        await vi.advanceTimersByTimeAsync(2000);
        await p2;
      } finally {
        vi.useRealTimers();
      }
    });
    it('an aborted turn that used a filler does not make the next turn count as after-a-filler', async () => {
      vi.useFakeTimers();
      try {
        const s = createSession('s', 0);
        const d = fdeps(delayed(5000, ['Real.']));
        const ac = new AbortController();
        const got1: string[] = [];
        const p1 = runTurn(d, s, 'one', { signal: ac.signal, onSentence: (x) => got1.push(x) });
        await vi.advanceTimersByTimeAsync(300);
        expect(got1).toHaveLength(1); // the filler went out
        ac.abort();
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        const got2: string[] = [];
        const p2 = runTurn(d, s, 'two', { onSentence: (x) => got2.push(x) });
        await vi.advanceTimersByTimeAsync(260);
        expect(got2).toHaveLength(1); // ordinary 250 ms delay
        await vi.advanceTimersByTimeAsync(5000);
        await p2;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('incomplete and failed replies', () => {
    const FIRST = 'A useful first sentence.';
    it('on an SDK error keeps the complete sentence and drops the broken tail', async () => {
      const s = createSession('s', 0);
      const got: string[] = [];
      const r = await runTurn(deps(fakeResponder([`${FIRST} `, 'a broken seco'], 2)), s, 'hi', { onSentence: (x) => got.push(x) });
      expect(got).toEqual([FIRST]);
      expect(r.reply).toBe(FIRST);
      expect(s.turns.at(-1)!.text).toBe(FIRST);
    });
    it('marks an SDK error with no stop reason as "error" in the trace', async () => {
      const d = deps(fakeResponder([`${FIRST} `, 'a broken seco'], 2));
      await runTurn(d, createSession('s', 0), 'hi');
      expect(d.traces.list('s')[0]!.modelStopReason).toBe('error');
    });
    it('on truncation (max_tokens) keeps the complete sentence and drops the tail', async () => {
      const s = createSession('s', 0);
      const got: string[] = [];
      const responder: Responder = { async *reply(req) { yield `${FIRST} a broken seco`; req.onStop?.('max_tokens'); throw new ReplyTruncatedError('max_tokens'); } };
      const d = deps(responder);
      const r = await runTurn(d, s, 'hi', { onSentence: (x) => got.push(x) });
      expect(got).toEqual([FIRST]);
      expect(r.reply).toBe(FIRST);
      expect(d.traces.list('s')[0]!.modelStopReason).toBe('max_tokens');
    });
    it('keeps a final complete sentence that has no trailing whitespace after a failure', async () => {
      const s = createSession('s', 0);
      const got: string[] = [];
      await runTurn(deps(fakeResponder(['One. Two.'], 1 /* throws after the first chunk is delivered */ )), s, 'hi', { onSentence: (x) => got.push(x) });
      expect(got).toEqual(['One.', 'Two.']);
    });
    it('keeps a punctuation mark split across deltas', async () => {
      const s = createSession('s', 0);
      const got: string[] = [];
      await runTurn(deps(fakeResponder(['Okay', '.'], 2)), s, 'hi', { onSentence: (x) => got.push(x) });
      expect(got).toEqual(['Okay.']);
    });
    it('emits the error line once when no complete sentence exists', async () => {
      for (const make of [() => fakeResponder(['a broken seco'], 1), () => ({ async *reply() { throw new ReplyTruncatedError('refusal'); } }) as Responder, () => fakeResponder([])]) {
        const s = createSession('s', 0);
        const got: string[] = [];
        const r = await runTurn(deps(make()), s, 'hi', { onSentence: (x) => got.push(x) });
        expect(got).toEqual([REPLY_ERROR]);
        expect(r.reply).toBe(REPLY_ERROR);
        expect(r.failed).toBe(true);
        expect(s.turns).toEqual([]);
      }
    });
    it('a clean end still flushes an unterminated tail', async () => {
      const s = createSession('s', 0);
      const got: string[] = [];
      await runTurn(deps(fakeResponder(['One. Tw'])), s, 'hi', { onSentence: (x) => got.push(x) });
      expect(got).toEqual(['One.', 'Tw']);
    });
    it('user cancellation gives no error apology and no truncation handling', async () => {
      const s = createSession('s', 0);
      const ac = new AbortController();
      const got: string[] = [];
      const responder: Responder = { async *reply() { yield 'Hello there. '; await new Promise(() => {}); } };
      const p = runTurn(deps(responder), s, 'hi', { signal: ac.signal, onSentence: (x) => { got.push(x); ac.abort(); } });
      const r = await p;
      expect(got).toEqual(['Hello there.']);
      expect(r.reply).not.toContain(REPLY_ERROR);
    });
    it('hands the responder an onStop that records the stop reason on the trace', async () => {
      const s = createSession('s', 0);
      const d = deps({ async *reply(req) { yield 'Fine.'; req.onStop?.('end_turn'); } });
      await runTurn(d, s, 'hi');
      expect(d.traces.list('s')[0]!.modelStopReason).toBe('end_turn');
    });
  });

  describe('commands', () => {
    it('scratch emits its prefix, records it, skips the responder and sets firstSentenceAt', async () => {
      const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'oops', 1);
      const responder = { reply: vi.fn(() => { throw new Error('should not run'); }) } as unknown as Responder;
      const d = { ...deps(responder), router: fakeRouter({ kind: 'scratch' }) };
      const got: string[] = [];
      const r = await runTurn(d, s, 'scratch that', { onSentence: (x) => got.push(x) });
      expect(got).toEqual(['Okay, go ahead.']);
      expect(r.reply).toBe('Okay, go ahead.');
      expect(responder.reply).not.toHaveBeenCalled();
      expect(s.turns.at(-1)).toMatchObject({ role: 'assistant', text: 'Okay, go ahead.' });
      expect(d.traces.list('s')[0]!.firstSentenceAt).toBeDefined();
    });
    it('a rolled-back park leaves the tree untouched', async () => {
      const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'x', 1); forkBranch(s, 'b1', 'fork', 'live', 2);
      const before = structuredClone({ branches: s.branches, turns: s.turns, cur: s.currentBranchId });
      const ac = new AbortController();
      await runTurn({ ...deps(slowResponder()), router: fakeRouter({ kind: 'park' }) }, s, 'hold that', { signal: ac.signal, onSentence: () => ac.abort() });
      expect({ branches: s.branches, turns: s.turns, cur: s.currentBranchId }).toEqual(before);
    });
    it('a rolled-back scratch leaves turns unscratched', async () => {
      const s = createSession('s', 0); appendTurn(s, 'b1', 'user', 'x', 1); appendTurn(s, 'b1', 'assistant', 'y', 2);
      const ac = new AbortController();
      await runTurn({ ...deps(slowResponder()), router: fakeRouter({ kind: 'scratch' }) }, s, 'scratch', { signal: ac.signal, onSentence: () => ac.abort() });
      expect(s.turns.map((t) => t.scratched)).toEqual([undefined, undefined]);
      expect(s.turns).toHaveLength(2);
    });
    it('a rolled-back set-aside turn restores awaitingSetAside', async () => {
      const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'live', 1); forkBranch(s, 'b1', 'fork', 'live', 2);
      const ac = new AbortController();
      await runTurn({ ...deps(slowResponder()), router: fakeRouter({ kind: 'fork', acknowledge: true }) }, s, 'another', { signal: ac.signal, onSentence: () => ac.abort() });
      expect(s.awaitingSetAside).toBeUndefined();
      expect(Object.keys(s.branches)).toEqual(['b1', 'b2', 'b3']);
      const t = createSession('t', 0); forkBranch(t, 'b1', 'fork', 'live', 1); forkBranch(t, 'b1', 'fork', 'live', 2);
      await runTurn({ ...deps(fakeResponder(['Which?'])), router: fakeRouter({ kind: 'fork', acknowledge: false }) }, t, 'another');
      const pending = structuredClone(t.awaitingSetAside);
      expect(pending?.asked).toBe(1);
      const ac2 = new AbortController();
      const r2 = runTurn({ ...deps(slowResponder()), router: fakeRouter({ kind: 'continue' }) }, t, 'hmm', { signal: ac2.signal });
      await tick(); await tick(); ac2.abort(); await r2;
      expect(t.awaitingSetAside).toEqual(pending);
    });
    it('a merge names the new branch from the source names; falls back on failure', async () => {
      const mk = () => { const s = createSession('s', 0); forkBranch(s, 'b1', 'fork', 'live', 1); return s; };
      const name = vi.fn(async () => 'Combined plan');
      const s = mk();
      await runTurn({ ...deps(fakeResponder(['Ok.'])), router: fakeRouter({ kind: 'merge', otherId: 'b1' }), namer: { name } }, s, 'combine them');
      await tick();
      expect(name).toHaveBeenCalledWith(mergeNamePrompt('New path', 'Main'));
      expect(s.branches.b3.name).toBe('Combined plan');
      const s2 = mk();
      const bad = { name: async () => { throw new Error('x'); } };
      await runTurn({ ...deps(fakeResponder(['Ok.'])), router: fakeRouter({ kind: 'merge', otherId: 'b1' }), namer: bad }, s2, 'combine them');
      await tick();
      expect(s2.branches.b3.name).toBe('New path + Main');
      const s3 = mk();
      await runTurn({ ...deps(fakeResponder(['Ok.'])), router: fakeRouter({ kind: 'merge', otherId: 'b1' }), namer: fakeNamer(null) }, s3, 'combine them');
      await tick();
      expect(s3.branches.b3.name).toBe('New path + Main');
      // Real session: the namer returned a source's name, so the end map showed two "Backyard barbecue instead".
      const s4 = mk();
      renameBranch(s4, 'b2', 'Backyard barbecue');
      await runTurn({ ...deps(fakeResponder(['Ok.'])), router: fakeRouter({ kind: 'merge', otherId: 'b1' }), namer: fakeNamer('Backyard barbecue') }, s4, 'combine them');
      await tick();
      expect(s4.branches.b3.name).toBe('Backyard barbecue + Main');
    });
    describe('digests', () => {
      const spy = () => {
        const seen: { notes: string[]; instruction?: string }[] = [];
        const responder: Responder = { async *reply(req) { seen.push({ notes: req.context.notes, instruction: req.instruction }); yield 'Done.'; } };
        return { seen, responder };
      };
      // b1 "Main" holds 'start'; b2 "New path" forks from it and holds its own turns.
      const twoBranches = (id = 's') => {
        const s = createSession(id, 0);
        appendTurn(s, 'b1', 'user', 'start', 1);
        const f = forkBranch(s, 'b1', 'fork', 'live', 2);
        appendTurn(s, f.id, 'user', 'podcast idea', 3); appendTurn(s, f.id, 'assistant', 'nice', 4);
        s.currentBranchId = 'b1';
        return s;
      };
      it('a merge puts one digest note per source in the reply context', async () => {
        const s = twoBranches();
        const { seen, responder } = spy();
        const digester = fakeDigester((n) => `about ${n}`);
        await runTurn({ ...deps(responder), digester, router: fakeRouter({ kind: 'merge', otherId: 'b2' }) }, s, 'combine them');
        expect(seen[0].notes).toEqual(['Thread "Main": about Main', 'Thread "New path": about New path']);
      });
      it('a compare puts the other branch digest in the notes', async () => {
        const s = twoBranches();
        const { seen, responder } = spy();
        await runTurn({ ...deps(responder), digester: fakeDigester('the podcast thread'), router: fakeRouter({ kind: 'compare', otherId: 'b2' }) }, s, 'difference?');
        expect(seen[0].notes).toEqual(['Thread "New path": the podcast thread']);
      });
      it('digests the effective history: inherited turns up to the fork point, then the branch own turns', async () => {
        // Was "digests only the branch own turns": that expectation is the P0 bug (a corrected plan reached a merge as only its correction).
        const s = twoBranches();
        const got: Turn[][] = [];
        const digester = { async digest(_n: string, turns: Turn[]) { got.push(turns); return 'd'; } };
        await runTurn({ ...deps(fakeResponder(['Ok.'])), digester, router: fakeRouter({ kind: 'compare', otherId: 'b2' }) }, s, 'diff');
        expect(got[0].map((x) => x.text)).toEqual(['start', 'podcast idea', 'nice']);
      });
      it('a corrected plan digests whole: fast digest input and the 300 ms fallback both keep the plan', async () => {
        const { session, correctedId } = correctedTrip();
        const unrelated = forkBranch(session, 'b1', 'fork', 'live', 50);
        appendTurn(session, unrelated.id, 'user', 'unrelated sibling sentinel', 51);
        session.currentBranchId = 'b1';
        const wanted = ['ski most mornings', 'ryokan', 'Hokkaido', 'Furano, not Niseko'];
        // Fast digester: sees the effective turns and the correction note.
        const seen: { turns: Turn[]; notes?: string[] }[] = [];
        const fast = { async digest(_n: string, turns: Turn[], _sig?: AbortSignal, notes?: string[]) { seen.push({ turns, notes }); return 'fast'; } };
        const { seen: ctx, responder } = (() => { const seen2: { notes: string[] }[] = []; return { seen: seen2, responder: { async *reply(req: any) { seen2.push({ notes: req.context.notes }); yield 'Ok.'; } } as Responder }; })();
        await runTurn({ ...deps(responder), digester: fast, router: fakeRouter({ kind: 'compare', otherId: correctedId }) }, session, 'compare');
        const turnText = seen.find((x) => x.turns.some((t) => t.text === 'Furano, not Niseko'))!.turns.map((t) => t.text).join('\n');
        for (const w of wanted) expect(turnText).toContain(w);
        expect(turnText).not.toContain('unrelated sibling sentinel');
        expect(ctx[0].notes[0]).toBe('Thread "Hokkaido ski trip": fast');
        // Slow digester: the 300 ms fallback still holds the whole plan.
        vi.useFakeTimers();
        try {
          const t2 = correctedTrip();
          t2.session.currentBranchId = 'b1';
          const slow = { async digest() { await new Promise((r) => setTimeout(r, 4000)); return 'late'; } };
          const spy2: string[][] = [];
          const r2: Responder = { async *reply(req) { spy2.push(req.context.notes); yield 'Ok.'; } };
          const p = runTurn({ ...deps(r2), digester: slow, router: fakeRouter({ kind: 'compare', otherId: t2.correctedId }) }, t2.session, 'compare');
          await vi.advanceTimersByTimeAsync(DIGEST_WAIT_MS);
          await p;
          const note = spy2[0][0];
          for (const w of wanted) expect(note).toContain(w);
          await vi.advanceTimersByTimeAsync(4000);
        } finally {
          vi.useRealTimers();
        }
      });
      it('a corrected merge keeps its source notes in a later reply', async () => {
        const { session, correctedId } = correctedMergedPlan();
        const seen: string[][] = [];
        const responder: Responder = { async *reply(req) { seen.push(req.context.notes); yield 'Ok.'; } };
        session.currentBranchId = correctedId;
        await runTurn({ ...deps(responder), router: fakeRouter({ kind: 'continue' }) }, session, 'and lodging?');
        const joined = seen[0].join('\n');
        expect(joined).toContain('SOURCE-DIGEST-ALPHA');
        expect(joined).toContain('SOURCE-DIGEST-BETA');
      });
      it('scratched details leave the digest input', async () => {
        const { session, correctedId } = correctedTrip();
        session.turns.find((t) => t.text === 'ski most mornings')!.scratched = true;
        session.currentBranchId = 'b1';
        const got: string[] = [];
        const digester = { async digest(_n: string, turns: Turn[]) { got.push(turns.map((t) => t.text).join('|')); return 'd'; } };
        await runTurn({ ...deps(fakeResponder(['Ok.'])), digester, router: fakeRouter({ kind: 'compare', otherId: correctedId }) }, session, 'diff');
        expect(got.some((g) => g.includes('ski most mornings'))).toBe(false);
        expect(got.some((g) => g.includes('Furano, not Niseko'))).toBe(true);
      });
      it('trimming an inherited turn in place changes the digest input and cache key', async () => {
        const { session, correctedId } = correctedTrip();
        session.currentBranchId = 'b1';
        const got: string[] = [];
        const digester = { async digest(_n: string, turns: Turn[]) { got.push(turns.map((t) => t.text).join('|')); return 'd'; } };
        const d = { ...deps(fakeResponder(['Ok.'])), digester, router: fakeRouter({ kind: 'compare', otherId: correctedId }, { kind: 'compare', otherId: correctedId }, { kind: 'compare', otherId: correctedId }) };
        await runTurn(d, session, 'diff');
        const count = () => got.filter((g) => g.includes('Furano')).length;
        const first = count();
        await runTurn(d, session, 'diff again');
        expect(count()).toBe(first); // same effective input: cached
        session.turns.find((t) => t.text === 'Then Niseko has the lifts you need.')!.text = 'Then Furano has the lifts you need.';
        await runTurn(d, session, 'diff 3');
        expect(count()).toBe(first + 1);
        expect(got.some((g) => g.includes('Furano has the lifts'))).toBe(true);
      });
      it('a failed digest falls back to the last user turns and the merge still happens', async () => {
        const s = twoBranches();
        const { seen, responder } = spy();
        const r = await runTurn({ ...deps(responder), digester: fakeDigester(new Error('down')), router: fakeRouter({ kind: 'merge', otherId: 'b2' }) }, s, 'combine them');
        expect(r.reply).toBe('Done.');
        expect(s.branches[r.branchId].mergedFrom).toEqual(['b1', 'b2']);
        // Effective history: the forked thread's digest includes what it inherited ('start').
        expect(seen[0].notes).toEqual(['Thread "Main": start', 'Thread "New path": start podcast idea']);
      });
      it('runs the merge digests concurrently', async () => {
        const s = twoBranches();
        let inflight = 0, peak = 0;
        const digester = { async digest() { peak = Math.max(peak, ++inflight); await tick(); inflight--; return 'd'; } };
        await runTurn({ ...deps(fakeResponder(['Ok.'])), digester, router: fakeRouter({ kind: 'merge', otherId: 'b2' }) }, s, 'combine');
        expect(peak).toBe(2);
      });
      it('caches by branch and last own turn; a new turn or a fallback is not reused', async () => {
        const s = twoBranches();
        const digester = fakeDigester('d');
        const d = { ...deps(fakeResponder(['Ok.'])), digester, router: fakeRouter({ kind: 'compare', otherId: 'b2' }, { kind: 'compare', otherId: 'b2' }, { kind: 'compare', otherId: 'b2' }) };
        // Each compare reply also warms the current branch ("Main") for a following merge; count the other branch.
        const others = () => digester.calls.filter((n) => n === 'New path');
        await runTurn(d, s, 'diff');
        await runTurn(d, s, 'diff again');
        expect(others()).toEqual(['New path']);
        appendTurn(s, 'b2', 'user', 'more', 9);
        await runTurn(d, s, 'diff 3');
        expect(others()).toEqual(['New path', 'New path']);
        const bad = fakeDigester(new Error('x'));
        const s2 = twoBranches('s2');
        const d2 = { ...deps(fakeResponder(['Ok.'])), digester: bad, router: fakeRouter({ kind: 'compare', otherId: 'b2' }, { kind: 'compare', otherId: 'b2' }) };
        await runTurn(d2, s2, 'diff'); await runTurn(d2, s2, 'diff');
        expect(bad.calls.filter((n) => n === 'New path')).toHaveLength(2);
      });
      it('arms the filler for a slow digest, never records it, and still skips it for prefix turns', async () => {
        vi.useFakeTimers();
        try {
          const s = twoBranches();
          const slow = { async digest() { await new Promise((r) => setTimeout(r, 400)); return 'd'; } };
          const d = { ...deps(fakeResponder(['Real.'])), digester: slow, filler: new FillerPicker(() => 0), router: fakeRouter({ kind: 'compare', otherId: 'b2' }) };
          const got: string[] = [];
          const p = runTurn(d, s, 'diff', { onSentence: (x) => got.push(x) });
          await vi.advanceTimersByTimeAsync(400);
          await p;
          expect(FILLERS).toContain(got[0]!);
        expect(got[0]).toBe(FILLERS[0]); // no trailing-space workaround: the SSE writer frames it with a flush tag
          expect(got.slice(1)).toEqual(['Real.']);
          expect(s.turns.at(-1)?.text).toBe('Real.');
          expect(d.traces.list('s')[0].filler).toBe(true);
          // prefix turn: no filler even with a slow responder
          const s2 = createSession('s2', 0); appendTurn(s2, 'b1', 'user', 'x', 1); forkBranch(s2, 'b1', 'fork', 'live', 2);
          const d2 = { ...deps({ async *reply() { await new Promise((r) => setTimeout(r, 400)); yield 'Ok.'; } }), filler: new FillerPicker(() => 0), router: fakeRouter({ kind: 'park' }) };
          const got2: string[] = [];
          const p2 = runTurn(d2, s2, 'hold that', { onSentence: (x) => got2.push(x) });
          await vi.advanceTimersByTimeAsync(400);
          await p2;
          expect(got2.some((x) => FILLERS.includes(x))).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });
      it('a slow digest does not hold the reply: the merge speaks from the fallback, then keeps the real digest', async () => {
        vi.useFakeTimers();
        try {
          const s = twoBranches();
          const { seen, responder } = spy();
          const slow = { async digest(n: string) { await new Promise((r) => setTimeout(r, 4000)); return `about ${n}`; } };
          const p = runTurn({ ...deps(responder), digester: slow, router: fakeRouter({ kind: 'merge', otherId: 'b2' }) }, s, 'combine them');
          await vi.advanceTimersByTimeAsync(DIGEST_WAIT_MS);
          const r = await p;
          expect(seen[0].notes).toEqual(['Thread "Main": start', 'Thread "New path": start podcast idea']);
          await vi.advanceTimersByTimeAsync(4000);
          expect(s.branches[r.branchId].mergeDigests).toEqual(['Thread "Main": about Main', 'Thread "New path": about New path']);
        } finally {
          vi.useRealTimers();
        }
      });
      it('an abort during a slow digest rolls a merge back and is not an error', async () => {
        const s = twoBranches();
        const before = structuredClone({ branches: s.branches, turns: s.turns, cur: s.currentBranchId });
        const hang = { digest: (_n: string, _t: Turn[], signal?: AbortSignal) => new Promise<string>((_, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted')))) };
        const ac = new AbortController();
        const responder = { reply: vi.fn() } as unknown as Responder;
        const p = runTurn({ ...deps(responder), digester: hang, router: fakeRouter({ kind: 'merge', otherId: 'b2' }) }, s, 'combine', { signal: ac.signal });
        await tick(); ac.abort();
        const r = await p;
        expect(r.reply).toBe('');
        expect(responder.reply).not.toHaveBeenCalled();
        expect({ branches: s.branches, turns: s.turns, cur: s.currentBranchId }).toEqual(before);
      });
    });
    it('two consecutive scratches remove the two most recent real exchanges', async () => {
      const s = createSession('s', 0);
      appendTurn(s, 'b1', 'user', 'one', 1); appendTurn(s, 'b1', 'assistant', 'r1', 2);
      appendTurn(s, 'b1', 'user', 'two', 3); appendTurn(s, 'b1', 'assistant', 'r2', 4);
      const d = { ...deps(fakeResponder([])), router: fakeRouter({ kind: 'scratch' }, { kind: 'scratch' }) };
      await runTurn(d, s, 'scratch that');
      await runTurn(d, s, 'scratch that');
      expect(s.turns.every((t) => t.scratched)).toBe(true);
      expect(s.turns).toHaveLength(8);
    });
  });
});

describe('reply deadline', () => {
  it('a stalled reply stops at the deadline, speaks the failure copy, stores nothing and frees the turn', async () => {
    vi.useFakeTimers();
    try {
      const s = createSession('s', 0);
      const got: string[] = [];
      let aborted = false;
      const stalled: Responder = { async *reply(_req, signal) { signal?.addEventListener('abort', () => { aborted = true; }); await new Promise(() => {}); yield 'never'; } };
      const r = runTurn(deps(stalled), s, 'hello', { noFiller: true, onSentence: (x) => got.push(x) });
      await vi.advanceTimersByTimeAsync(REPLY_DEADLINE_MS + 1);
      const res = await r;
      expect(res.failed).toBe(true);
      expect(got).toEqual([REPLY_ERROR]);
      expect(aborted).toBe(true); // the upstream stream is told to stop
      expect(s.turns).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
