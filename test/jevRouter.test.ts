import { describe, expect, it } from 'vitest';
import { JevRouter, NullRouter, ROUTER_SPEC_VERSION, hashSpec, jevRequest } from '../src/route/jev.js';
import type { RouteInput } from '../src/route/types.js';

const input: RouteInput = {
  utterance: 'what about a totally different approach',
  current: { id: 'b1', name: 'Main', summary: 'launch plan', provisional: false, lastUser: 'we should launch in May', lastAssistant: 'May works well.' },
  others: [{ id: 'b2', name: 'Newsletter', summary: 'weekly design notes' }],
};

const fake = {
  systemOne: async () => ({
    model: 'jev-x',
    answers: {
      intent: { choice: 'newDirection', confidence: 0.95 },
      target: { choice: 'none', confidence: 0.9 },
      detailNotDirection: { noul: 0.1 },
      takesUpSuggestion: { noul: 0 },
    },
  }),
} as any;

describe('router spec', () => {
  it('takesUpSuggestion only fires for adopting a different option, not agreeing or answering', () => {
    const text = JSON.stringify(jevRequest(input).questions.takesUpSuggestion);
    expect(text).toMatch(/different option or idea/);
    expect(text).toMatch(/not merely agreeing, confirming, or answering/);
  });
  it('hashSpec depends on question texts and choices', () => {
    expect(hashSpec({ q: 'a' })).toBe(hashSpec({ q: 'a' }));
    expect(hashSpec({ q: 'a' })).not.toBe(hashSpec({ q: 'b' }));
    expect(ROUTER_SPEC_VERSION).toMatch(/^[0-9a-f]{8,}$/);
  });
});

describe('JevRouter', () => {
  it('maps Jev answers through the policy', async () => {
    const d = await new JevRouter({ client: fake }).route(input);
    expect(d).toMatchObject({ op: { kind: 'fork', acknowledge: false }, intent: 'newDirection', by: 'jev' });
    expect(d.raw?.detailNotDirection).toBe(0.1);
  });
  it('offers every listed branch plus none as targets', () => {
    const q = jevRequest(input).questions.target;
    expect(Object.keys(q.criteria)).toEqual(expect.arrayContaining(['b2', 'none']));
  });
  it('times out to continue', async () => {
    const slow = { systemOne: () => new Promise(() => {}) } as any;
    const d = await new JevRouter({ client: slow, timeoutMs: 20 }).route(input);
    expect(d).toMatchObject({ op: { kind: 'continue' }, by: 'fallback', reason: 'timeout' });
  });
  it('aborts the request signal when the timeout is lost', async () => {
    let signal: AbortSignal | undefined;
    const slow = { systemOne: (_r: unknown, o?: { signal?: AbortSignal }) => { signal = o?.signal; return new Promise(() => {}); } } as any;
    await new JevRouter({ client: slow, timeoutMs: 20 }).route(input);
    expect(signal?.aborted).toBe(true);
  });
  it('errors fall back to continue', async () => {
    const bad = { systemOne: () => Promise.reject(new Error('boom')) } as any;
    expect((await new JevRouter({ client: bad }).route(input)).op).toEqual({ kind: 'continue' });
  });
});

describe('NullRouter', () => {
  it('always continues', async () => {
    expect(await new NullRouter().route(input)).toEqual({ op: { kind: 'continue' }, intent: null, by: 'fallback', ms: 0, reason: 'router disabled' });
  });
});
