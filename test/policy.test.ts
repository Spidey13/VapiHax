import { describe, it, expect } from 'vitest';
import { decide, THRESHOLDS, type Thresholds } from '../src/route/policy.js';
import type { RawAnswers, RouteInput } from '../src/route/types.js';

const raw = (partial: Partial<RawAnswers> = {}): RawAnswers => ({
  intent: { choice: 'continue', confidence: 0.9 },
  target: { choice: 'none', confidence: 0.9 },
  detailNotDirection: 0.5,
  takesUpSuggestion: 0,
  ...partial,
});

const input: RouteInput = {
  utterance: 'hello',
  current: { id: 'b1', name: 'Main', summary: '', provisional: false, lastUser: 'earlier', lastAssistant: null },
  others: [{ id: 'b2', name: 'Newsletter', summary: '' }],
};

describe('decide', () => {
  it('low intent confidence continues', () => expect(decide(raw({ intent: { choice: 'newDirection', confidence: 0.5 } }), input).op).toEqual({ kind: 'continue' }));
  it('new direction with a direction change forks; acknowledged only in the 0.7–0.85 band', () => {
    expect(decide(raw({ intent: { choice: 'newDirection', confidence: 0.8 }, detailNotDirection: 0.1 }), input).op).toEqual({ kind: 'fork', acknowledge: true });
    expect(decide(raw({ intent: { choice: 'newDirection', confidence: 0.95 }, detailNotDirection: 0.1 }), input).op).toEqual({ kind: 'fork', acknowledge: false });
  });
  it('a detail change is a correction whether Jev said newDirection or correction', () => {
    expect(decide(raw({ intent: { choice: 'newDirection', confidence: 0.9 }, detailNotDirection: 0.8 }), input).op).toEqual({ kind: 'correct' });
    expect(decide(raw({ intent: { choice: 'correction', confidence: 0.9 }, detailNotDirection: 0.8 }), input).op).toEqual({ kind: 'correct' });
  });
  it('an unclear detail score explores rather than corrects', () =>
    expect(decide(raw({ intent: { choice: 'correction', confidence: 0.9 }, detailNotDirection: 0.5 }), input).op.kind).toBe('fork'));
  it('taking up the assistant suggestion forks', () => {
    const offered = { ...input, current: { ...input.current, lastAssistant: 'You could also skip the conference and run a virtual launch. Want to explore that?' } };
    expect(decide(raw({ intent: { choice: 'continue', confidence: 0.9 }, takesUpSuggestion: 0.8 }), offered).op.kind).toBe('fork');
  });
  it('answering a plain question with a refinement continues, even when Jev scores it as taking up a suggestion', () => {
    // Real session: the assistant asked a question, the user elaborated the barbecue plan, and it forked.
    const refinement = {
      utterance: 'How about we do this on a Saturday afternoon? With the grill and a few long tables under string lights.',
      current: { id: 'b2', name: 'Backyard barbecue', summary: '', provisional: false, lastUser: 'What if we did a backyard barbecue instead?',
        lastAssistant: 'A backyard barbecue could feel more relaxed and personal for your dad. Who would be on the grill though, since whoever cooks for twenty tends to miss a lot of the party?' },
      others: [{ id: 'b1', name: 'Restaurant dinner', summary: '' }],
    };
    expect(decide(raw({ intent: { choice: 'continue', confidence: 0.76 }, target: { choice: 'b1', confidence: 0.64 }, detailNotDirection: 0.42, takesUpSuggestion: 0.79 }), refinement).op).toEqual({ kind: 'continue' });
  });
  it('switch needs a confident target that is one of the offered others', () => {
    expect(decide(raw({ intent: { choice: 'switchBack', confidence: 0.9 }, target: { choice: 'b2', confidence: 0.7 } }), input).op).toEqual({ kind: 'switch', targetId: 'b2' });
    expect(decide(raw({ intent: { choice: 'switchBack', confidence: 0.9 }, target: { choice: 'b2', confidence: 0.4 } }), input).op).toEqual({ kind: 'ask-which' });
    expect(decide(raw({ intent: { choice: 'switchBack', confidence: 0.9 }, target: { choice: 'none', confidence: 0.9 } }), input).op).toEqual({ kind: 'ask-which' });
    expect(decide(raw({ intent: { choice: 'switchBack', confidence: 0.9 }, target: { choice: 'b1', confidence: 0.9 } }), input).op).toEqual({ kind: 'ask-which' });
    expect(decide(raw({ intent: { choice: 'switchBack', confidence: 0.9 }, target: { choice: 'b7', confidence: 0.9 } }), input).op).toEqual({ kind: 'ask-which' });
  });
  it('park, scratch and recap map to their ops at or above the intent threshold', () => {
    for (const k of ['park', 'scratch', 'recap'] as const) {
      const d = decide(raw({ intent: { choice: k, confidence: 0.7 } }), input);
      expect(d.op).toEqual({ kind: k });
      expect(d.intent).toBe(k);
    }
  });
  it('a low-confidence command continues', () =>
    expect(decide(raw({ intent: { choice: 'park', confidence: 0.5 } }), input).op).toEqual({ kind: 'continue' }));
});

describe('compare and merge ops', () => {
  const three: RouteInput = { ...input, others: [{ id: 'b2', name: 'A', summary: '' }, { id: 'b3', name: 'B', summary: '' }] };
  const none: RouteInput = { ...input, others: [] };
  const cmd = (choice: 'compare' | 'merge', target = { choice: 'none', confidence: 0.9 }) => raw({ intent: { choice, confidence: 0.9 }, target });
  it('compare uses a confident target', () =>
    expect(decide(cmd('compare', { choice: 'b3', confidence: 0.7 }), three).op).toEqual({ kind: 'compare', otherId: 'b3' }));
  it('compare without a confident target uses the most recently active other', () => {
    expect(decide(cmd('compare'), three).op).toEqual({ kind: 'compare', otherId: 'b2' });
    expect(decide(cmd('compare', { choice: 'b3', confidence: 0.4 }), three).op).toEqual({ kind: 'compare', otherId: 'b2' });
    expect(decide(cmd('compare', { choice: 'b1', confidence: 0.9 }), three).op).toEqual({ kind: 'compare', otherId: 'b2' });
  });
  it('compare with no others is only-one-thread', () =>
    expect(decide(cmd('compare'), none).op).toEqual({ kind: 'only-one-thread' }));
  it('merge uses a confident target', () =>
    expect(decide(cmd('merge', { choice: 'b3', confidence: 0.8 }), three).op).toEqual({ kind: 'merge', otherId: 'b3' }));
  it('merge with exactly one other and no confident target merges with it', () =>
    expect(decide(cmd('merge'), input).op).toEqual({ kind: 'merge', otherId: 'b2' }));
  it('merge with several others and no confident target asks which to combine with', () =>
    expect(decide(cmd('merge'), three).op).toEqual({ kind: 'ask-merge' }));
  it('merge with no others is only-one-thread', () =>
    expect(decide(cmd('merge'), none).op).toEqual({ kind: 'only-one-thread' }));
});

describe('decide before the first user turn', () => {
  const fresh: RouteInput = { ...input, current: { ...input.current, lastUser: null } };
  it('never forks on newDirection', () => {
    const d = decide(raw({ intent: { choice: 'newDirection', confidence: 0.95 }, detailNotDirection: 0.1 }), fresh);
    expect(d.op).toEqual({ kind: 'continue' });
    expect(d.intent).toBe('newDirection');
  });
  it('never corrects', () =>
    expect(decide(raw({ intent: { choice: 'correction', confidence: 0.9 }, detailNotDirection: 0.8 }), fresh).op).toEqual({ kind: 'continue' }));
  it('never forks on taking up a suggestion', () =>
    expect(decide(raw({ intent: { choice: 'continue', confidence: 0.9 }, takesUpSuggestion: 0.9 }), fresh).op).toEqual({ kind: 'continue' }));
  it('still switches', () =>
    expect(decide(raw({ intent: { choice: 'switchBack', confidence: 0.9 }, target: { choice: 'b2', confidence: 0.9 } }), fresh).op).toEqual({ kind: 'switch', targetId: 'b2' }));
});

describe('decide with custom thresholds', () => {
  it('uses the supplied thresholds, including the acknowledge band', () => {
    const r = raw({ intent: { choice: 'newDirection', confidence: 0.75 }, detailNotDirection: 0.1 });
    expect(decide(r, input, { ...THRESHOLDS, intent: 0.8 }).op).toEqual({ kind: 'continue' });
    expect(decide(r, input, { ...THRESHOLDS, ackHigh: 0.75 }).op).toEqual({ kind: 'fork', acknowledge: false });
    expect(decide(raw({ intent: { choice: 'correction', confidence: 0.9 }, detailNotDirection: 0.6 }), input, { ...THRESHOLDS, detailHigh: 0.5 }).op).toEqual({ kind: 'correct' });
  });
});

describe('boundaries at the tuned thresholds', () => {
  it('intent confidence exactly at THRESHOLDS.intent is accepted', () => {
    const r = raw({ intent: { choice: 'newDirection', confidence: THRESHOLDS.intent }, detailNotDirection: 0.1 });
    expect(decide(r, input).op.kind).toBe('fork');
    expect(decide(raw({ intent: { choice: 'newDirection', confidence: THRESHOLDS.intent - 0.01 }, detailNotDirection: 0.1 }), input).op).toEqual({ kind: 'continue' });
  });
  it('target confidence exactly at THRESHOLDS.target is accepted', () => {
    const sw = (c: number) => raw({ intent: { choice: 'switchBack', confidence: 0.9 }, target: { choice: 'b2', confidence: c } });
    expect(decide(sw(THRESHOLDS.target), input).op).toEqual({ kind: 'switch', targetId: 'b2' });
    expect(decide(sw(THRESHOLDS.target - 0.01), input).op).toEqual({ kind: 'ask-which' });
  });
  it('detail score exactly at THRESHOLDS.detailHigh corrects', () => {
    expect(decide(raw({ intent: { choice: 'correction', confidence: 0.9 }, detailNotDirection: THRESHOLDS.detailHigh }), input).op).toEqual({ kind: 'correct' });
  });
});

describe('acknowledge band is [intent, ackHigh)', () => {
  const fork = (c: number, t: Thresholds = THRESHOLDS) => decide(raw({ intent: { choice: 'newDirection', confidence: c }, detailNotDirection: 0.1 }), input, t).op;
  it('acknowledges at the accept threshold itself', () => {
    expect(fork(THRESHOLDS.intent)).toEqual({ kind: 'fork', acknowledge: true });
    expect(fork(0.65)).toEqual({ kind: 'fork', acknowledge: true });
  });
  it('does not acknowledge at or above ackHigh', () => {
    expect(fork(THRESHOLDS.ackHigh)).toEqual({ kind: 'fork', acknowledge: false });
  });
  it('the band edge follows a tuned intent threshold and THRESHOLDS has no ackLow', () => {
    expect(fork(0.72, { ...THRESHOLDS, intent: 0.7 })).toEqual({ kind: 'fork', acknowledge: true });
    expect('ackLow' in THRESHOLDS).toBe(false);
  });
});
