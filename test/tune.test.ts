import { describe, it, expect } from 'vitest';
import { tune, tuneBoth } from '../src/route/tune.js';
import { THRESHOLDS } from '../src/route/policy.js';
import type { EvalItem } from '../src/route/score.js';
import type { RawAnswers, RouteInput } from '../src/route/types.js';

const input: RouteInput = {
  utterance: 'x',
  current: { id: 'b1', name: 'Main', summary: '', provisional: false, lastUser: 'earlier', lastAssistant: 'Another option is a podcast instead. Want to explore that?' },
  others: [{ id: 'b2', name: 'Other', summary: '' }],
};
const raw = (conf: number, choice: RawAnswers['intent']['choice'] = 'newDirection'): RawAnswers => ({
  intent: { choice, confidence: conf }, target: { choice: 'none', confidence: 0 }, detailNotDirection: 0.1, takesUpSuggestion: 0,
});
const row = (id: string, expect: EvalItem['expect'], r: RawAnswers) => ({ item: { id, input, expect } as EvalItem, raw: r });
const grid = { intent: [0.6, 0.7, 0.8], detailHigh: [0.7], target: [0.6] };

describe('tune', () => {
  it('picks the most accurate point that meets the false-fork limit', () => {
    // 12 true forks at 0.75 confidence: intent 0.6 and 0.7 fork them, 0.8 does not.
    // one continue at 0.65 confidence: intent 0.6 falsely forks it (1/13 = 0.077, still under 0.10), 0.7 does not.
    const rows = [...Array.from({ length: 12 }, (_, i) => row(`f${i}`, 'fork', raw(0.75))), row('c1', 'continue', raw(0.65))];
    const r = tune(rows, grid);
    expect(r.best?.intent).toBe(0.7);
    expect(r.table).toHaveLength(3);
    expect(r.table.find((t) => t.thresholds.intent === 0.8)?.accuracy).toBeCloseTo(1 / 13);
  });
  it('excludes a more accurate point that breaks the false-fork limit', () => {
    // intent 0.6 is the most accurate (7/9) but falsely forks 2 of 8 forks: rate 0.25.
    const rows = [...Array.from({ length: 6 }, (_, i) => row(`f${i}`, 'fork', raw(0.65))), row('c1', 'continue', raw(0.65)), row('c2', 'continue', raw(0.65)), row('c3', 'continue', raw(0.9, 'continue'))];
    const r = tune(rows, grid);
    expect(r.best?.intent).toBe(0.8);
    expect(r.table.find((t) => t.thresholds.intent === 0.6)?.falseForkRate).toBe(0.25);
  });
  it('breaks accuracy ties by the higher intent threshold', () => {
    const rows = [row('f1', 'fork', raw(0.95)), row('c1', 'continue', raw(0.95, 'continue'))];
    expect(tune(rows, grid).best?.intent).toBe(0.8);
  });
  it('returns best: null when no point meets the limit', () => {
    const rows2 = [row('c1', 'continue', raw(0.95)), row('c2', 'continue', raw(0.95))];
    expect(tune(rows2, grid).best).toBeNull();
    expect(tune(rows2, grid).table).toHaveLength(3);
  });
  it('fills the untuned thresholds from THRESHOLDS', () => {
    const r = tune([row('f1', 'fork', raw(0.95))], grid);
    expect(r.best?.takesUp).toBe(THRESHOLDS.takesUp);
    expect(r.best?.ackHigh).toBe(THRESHOLDS.ackHigh);
  });
});

describe('tuneBoth', () => {
  // A true takes-up fork at 0.75 and a plain continue scored 0.85 by the takes-up question.
  const tk = (id: string, expect: EvalItem['expect'], takesUp: number) => row(id, expect, { ...raw(0.9, 'continue'), takesUpSuggestion: takesUp });
  const rows = [tk('f1', 'fork', 0.95), tk('f2', 'fork', 0.95), tk('c1', 'continue', 0.85)];
  const g = { intent: [0.7], detailHigh: [0.7], target: [0.6] };
  it('keeps the plan grid when it qualifies', () => {
    const r = tuneBoth([tk('f1', 'fork', 0.95), tk('c1', 'continue', 0.1)], g, { takesUp: [0.7, 0.8, 0.9] });
    expect(r.source).toBe('plan');
    expect(r.chosen?.takesUp).toBe(0.7);
  });
  it('falls back to the extended grid only when the plan grid has no qualifying point', () => {
    const r = tuneBoth(rows, g, { takesUp: [0.7, 0.8, 0.9] });
    expect(r.plan.best).toBeNull();
    expect(r.source).toBe('extended');
    expect(r.chosen?.takesUp).toBe(0.9);
  });
  it('breaks ties by the higher takesUp in the extended grid', () => {
    const r = tuneBoth([tk('f1', 'fork', 0.95), tk('c1', 'continue', 0.75)], g, { takesUp: [0.7, 0.8, 0.9] });
    expect(r.chosen?.takesUp).toBe(0.9);
  });
  it('is null when neither grid qualifies', () => {
    const r = tuneBoth([tk('c1', 'continue', 0.99)], g, { takesUp: [0.7, 0.8, 0.9] });
    expect(r.chosen).toBeNull();
    expect(r.source).toBe('none');
  });
});

describe('tune tie-break order', () => {
  it('prefers higher intent, then higher takesUp, then lower detailHigh, then lower target', () => {
    const rows = [row('f1', 'fork', raw(0.95))]; // every grid point scores the same
    const r = tune(rows, { intent: [0.6, 0.8], detailHigh: [0.6, 0.8], target: [0.5, 0.7], takesUp: [0.7, 0.9] });
    expect(r.best).toMatchObject({ intent: 0.8, takesUp: 0.9, detailHigh: 0.6, target: 0.5 });
  });
});
