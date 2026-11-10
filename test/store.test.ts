import { describe, it, expect } from 'vitest';
import { CaseStore, IDLE_EXPIRY_MS, isStampCurrent } from '../src/case/store.js';
import { setFact } from '../src/case/facts.js';

describe('store', () => {
  it('sessions are isolated', () => {
    const store = new CaseStore();
    const a = store.createCase();
    const b = store.createCase();
    setFact(a, 'phone.platform', 'ios', 'user-report');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(store.getCase(b.sessionId)!.facts['phone.platform'].value).toBeNull();
    expect(store.getCase(a.sessionId)!.facts['phone.platform'].value).toBe('ios');
  });

  it('reset increments epoch, reseeds fixture, and old stamps are stale', () => {
    const store = new CaseStore();
    const a = store.createCase();
    setFact(a, 'phone.platform', 'ios', 'user-report');
    const stamp = { sessionId: a.sessionId, epoch: a.epoch, fieldVersions: { 'phone.platform': 1 } };
    expect(isStampCurrent(a, stamp)).toBe(true);
    const r = store.resetCase(a.sessionId)!;
    expect(r.epoch).toBe(2);
    expect(r.facts['phone.platform'].value).toBeNull();
    expect(r.facts['accessory.product'].value).toBe('10EBU4151');
    expect(r.attempts).toHaveLength(0);
    expect(isStampCurrent(r, stamp)).toBe(false);
  });

  it('stamp goes stale when a stamped field changes', () => {
    const store = new CaseStore();
    const a = store.createCase();
    setFact(a, 'phone.platform', 'ios', 'user-report');
    const stamp = { sessionId: a.sessionId, epoch: a.epoch, fieldVersions: { 'phone.platform': 1 } };
    setFact(a, 'phone.platform', 'android', 'user-report');
    expect(isStampCurrent(a, stamp)).toBe(false);
  });

  it('idle > 30 minutes expires the case (injected clock)', () => {
    let t = 1_000_000;
    const store = new CaseStore(() => t);
    const a = store.createCase();
    t += IDLE_EXPIRY_MS - 1000;
    expect(store.getCase(a.sessionId)).toBeDefined(); // touch resets idle timer
    t += IDLE_EXPIRY_MS + 1;
    expect(store.getCase(a.sessionId)).toBeUndefined();
  });
});
