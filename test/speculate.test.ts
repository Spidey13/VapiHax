import { describe, it, expect } from 'vitest';
import { Speculator, normalise } from '../src/route/speculate.js';
import { appendTurn, createSession } from '../src/tree/tree.js';
import type { RouteDecision, Router } from '../src/route/types.js';

function countingRouter() {
  const r = {
    calls: 0,
    async route(): Promise<RouteDecision> {
      r.calls++;
      return { op: { kind: 'continue' }, intent: null, by: 'jev', ms: 1, reason: '' };
    },
  };
  return r satisfies Router & { calls: number };
}

describe('normalise', () => {
  it('lower-cases, collapses whitespace, strips trailing punctuation and quotes', () => {
    expect(normalise('  "Or  a Podcast?!" ')).toBe('or a podcast');
  });
});

describe('Speculator', () => {
  it('routes once when the same partial arrives twice, on a copy of the session', async () => {
    const router = countingRouter();
    const s = createSession('s', 0);
    const sp = new Speculator(router);
    expect(await sp.onPartial(s, 'or a podcast')).toBe(false);
    expect(await sp.onPartial(s, 'or a podcast')).toBe(true);
    expect(await sp.onPartial(s, 'or a podcast')).toBe(false);
    expect(router.calls).toBe(1);
    expect(sp.runs).toBe(1);
    expect(s.revision).toBe(0);
  });

  it('never caches a fallback (timeout or error), so the final turn routes again', async () => {
    let calls = 0;
    const router: Router = {
      async route(): Promise<RouteDecision> {
        calls++;
        return { op: { kind: 'continue' }, intent: null, by: 'fallback', ms: 700, reason: 'timeout' };
      },
    };
    const s = createSession('s', 0);
    const sp = new Speculator(router);
    await sp.onPartial(s, 'go back to the city trip');
    expect(await sp.onPartial(s, 'go back to the city trip')).toBe(true);
    expect(sp.lookup(s, 'Go back to the city trip.')).toBeNull();
    // a later repeat of the same stable partial may try again
    expect(await sp.onPartial(s, 'go back to the city trip')).toBe(true);
    expect(calls).toBe(2);
  });

  it('reuses the decision when the final differs only in case and punctuation', async () => {
    const s = createSession('s', 0);
    const sp = new Speculator(countingRouter());
    await sp.onPartial(s, 'or a podcast');
    await sp.onPartial(s, 'or a podcast');
    expect(sp.lookup(s, 'Or a podcast?')?.op).toEqual({ kind: 'continue' });
  });

  it('ignores a speculation for different final text or after the revision moved', async () => {
    const s = createSession('s', 0);
    const sp = new Speculator(countingRouter());
    await sp.onPartial(s, 'or a podcast');
    await sp.onPartial(s, 'or a podcast');
    expect(sp.lookup(s, 'or a newsletter')).toBeNull();
    appendTurn(s, s.currentBranchId, 'user', 'x', 1);
    expect(sp.lookup(s, 'or a podcast')).toBeNull();
  });

  it('endUtterance clears the cache', async () => {
    const s = createSession('s', 0);
    const sp = new Speculator(countingRouter());
    await sp.onPartial(s, 'or a podcast');
    await sp.onPartial(s, 'or a podcast');
    sp.endUtterance('s');
    expect(sp.lookup(s, 'or a podcast')).toBeNull();
  });

  it('does not route again for identical partials while a routing is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const router: Router = { async route() { calls++; await gate; return { op: { kind: 'continue' }, intent: null, by: 'jev', ms: 1, reason: '' }; } };
    const s = createSession('s', 0);
    const sp = new Speculator(router);
    const all = [1, 2, 3, 4].map(() => sp.onPartial(s, 'or a podcast'));
    expect(sp.lookup(s, 'or a podcast')).toBeNull(); // in-flight is never returned
    release();
    expect((await Promise.all(all)).filter(Boolean)).toHaveLength(1);
    expect(calls).toBe(1);
    expect(sp.lookup(s, 'or a podcast')).not.toBeNull();
  });

  it('replaces a trailing-off stable partial with the next utterance', async () => {
    const s = createSession('s', 0);
    const sp = new Speculator(countingRouter());
    await sp.onPartial(s, 'or maybe');
    await sp.onPartial(s, 'or maybe');
    await sp.onPartial(s, 'a podcast');
    await sp.onPartial(s, 'a podcast');
    expect(sp.lookup(s, 'or maybe')).toBeNull();
    expect(sp.lookup(s, 'a podcast')).not.toBeNull();
  });

  it('sets trace fields', async () => {
    const s = createSession('s', 0);
    const sp = new Speculator(countingRouter());
    const trace: { stablePartialAt?: number } = {};
    await sp.onPartial(s, 'hi there', trace);
    expect(trace.stablePartialAt).toBeUndefined();
    await sp.onPartial(s, 'hi there', trace);
    expect(trace.stablePartialAt).toBeTypeOf('number');
  });
});
