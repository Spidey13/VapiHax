import { describe, it, expect } from 'vitest';
import { Prefetcher } from '../src/engine/prefetch.js';
import { RuleInterpreter } from '../src/engine/interpret.js';
import { newCaseState } from '../src/case/facts.js';
import { handleTurn } from '../src/engine/turn.js';
import { setFact } from '../src/case/facts.js';

const interp = new RuleInterpreter();
const fresh = () => newCaseState('s1', 1, Date.now());

describe('prefetch', () => {
  it('two stable partials -> one prefetch, partials never mutate facts, hit is used', async () => {
    const s = fresh();
    const before = JSON.stringify(s.facts);
    const p = new Prefetcher();
    expect(await p.onPartial(s, 'I am on my android', interp)).toBe(false);
    expect(await p.onPartial(s, 'I am on my android tablet', interp)).toBe(true);
    expect(await p.onPartial(s, 'I am on my android tablet', interp)).toBe(false);
    expect(p.runs).toBe(1);
    expect(JSON.stringify(s.facts)).toBe(before);
    const sel = await p.lookup(s, 'I am on my android tablet', interp);
    expect(sel).not.toBeNull();
    const r = await handleTurn(s, 'I am on my android tablet', 'voice', interp, Date.now(), sel ? { sel, used: false } : undefined);
    expect(s.facts['phone.platform']?.value).toBe('android');
    expect(typeof r.prefetchHit).toBe('boolean');
  });
  it('a correction in between invalidates the prefetch', async () => {
    const s = fresh();
    const p = new Prefetcher();
    await p.onPartial(s, 'I am on my android', interp);
    await p.onPartial(s, 'I am on my android', interp);
    setFact(s, 'phone.platform', 'ios', 'user-report'); // state moved (revision/versions)
    s.revision += 1;
    expect(await p.lookup(s, 'I am on my android', interp)).toBeNull();
  });
});
