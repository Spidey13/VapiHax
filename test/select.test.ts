import { describe, it, expect } from 'vitest';
import { newCaseState, setFact } from '../src/case/facts.js';
import { recordAttempt } from '../src/case/attempts.js';
import { selectNext } from '../src/engine/select.js';

const fresh = () => newCaseState('s', 1, 0);

describe('selectNext', () => {
  it('android with unknown google services -> clarify, no check', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'android', 'user-report');
    const sel = selectNext(s);
    expect(sel.kind).toBe('clarify');
    if (sel.kind === 'clarify') expect(sel.question).toBe('phone.googleServices');
  });

  it('android + google services -> android sync, stamped with both versions', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'android', 'user-report');
    setFact(s, 'phone.googleServices', 'yes', 'user-report');
    const sel = selectNext(s);
    expect(sel.kind).toBe('check');
    if (sel.kind === 'check') {
      expect(sel.check.id).toBe('android-credential-sync');
      expect(sel.stamp.fieldVersions['phone.platform']).toBe(1);
      expect(sel.stamp.fieldVersions['phone.googleServices']).toBe(1);
      expect(sel.stamp.epoch).toBe(1);
      expect(sel.stamp.sessionId).toBe('s');
    }
  });

  it('android without google services never gets the android sync', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'android', 'user-report');
    setFact(s, 'phone.googleServices', 'no', 'user-report');
    expect(selectNext(s).kind).toBe('unresolved');
  });

  it('ios -> ios sync; android check never eligible', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'ios', 'user-report');
    setFact(s, 'phone.googleServices', 'yes', 'user-report');
    const sel = selectNext(s);
    expect(sel.kind === 'check' && sel.check.id).toBe('ios-credential-sync');
  });

  it('unknown phone -> asks which phone', () => {
    const sel = selectNext(fresh());
    expect(sel.kind).toBe('clarify');
    if (sel.kind === 'clarify') expect(sel.question).toBe('phone.platform');
  });

  it('a check with a failed applicable attempt is not reissued', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'ios', 'user-report');
    recordAttempt(s, 'ios-credential-sync', 'failed');
    const sel = selectNext(s);
    expect(sel.kind === 'check' && sel.check.id).not.toBe('ios-credential-sync');
    expect(sel.kind).toBe('unresolved');
  });

  it('a not-applicable failed attempt does not block or count', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'ios', 'user-report');
    const a = recordAttempt(s, 'ios-credential-sync', 'failed');
    a.applicable = false;
    const sel = selectNext(s);
    expect(sel.kind === 'check' && sel.check.id).toBe('ios-credential-sync');
  });

  it('two distinct failed checks -> handoff', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'ios', 'user-report');
    setFact(s, 'sync.status', 'reported-done', 'user-report');
    recordAttempt(s, 'ios-credential-sync', 'failed');
    recordAttempt(s, 'retry-pairing-once', 'failed');
    expect(selectNext(s).kind).toBe('handoff');
  });

  it('apple tv blocker -> unsupported, no reset/shopping text', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'ios', 'user-report');
    setFact(s, 'hub.model', 'apple-tv-4k-3gen-64gb-wifi', 'user-report');
    const sel = selectNext(s);
    expect(sel.kind).toBe('unsupported');
    if (sel.kind === 'unsupported') {
      const text = `${sel.check.actionText} ${sel.check.expectedObservation} ${sel.check.stopConditions}`.toLowerCase();
      expect(text).not.toMatch(/b(reset|buy|purchase|shop|order)b/);
    }
  });

  it('unknown firmware does not block checks', () => {
    const s = fresh();
    expect(s.facts['accessory.firmware'].value).toBeNull();
    setFact(s, 'phone.platform', 'ios', 'user-report');
    expect(selectNext(s).kind).toBe('check');
  });

  it('sync reported done -> retry pairing once', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'android', 'user-report');
    setFact(s, 'phone.googleServices', 'yes', 'user-report');
    setFact(s, 'sync.status', 'reported-done', 'user-report');
    const sel = selectNext(s);
    expect(sel.kind === 'check' && sel.check.id).toBe('retry-pairing-once');
  });

  it('disputed fact withholds advice', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'ios', 'typed');
    setFact(s, 'phone.platform', 'android', 'user-report');
    const sel = selectNext(s);
    expect(sel.kind).toBe('clarify');
    if (sel.kind === 'clarify') expect(sel.question).toBe('conflict');
  });
});
