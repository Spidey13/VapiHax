import { describe, it, expect } from 'vitest';
import { newCaseState, setFact, resolveConflict } from '../src/case/facts.js';

const fresh = () => newCaseState('s1', 1, 1000);

describe('facts', () => {
  it('fixture loads with unknown firmware', () => {
    const s = fresh();
    expect(s.facts['accessory.firmware'].value).toBeNull();
    expect(s.facts['accessory.firmware'].status).toBe('unknown');
    expect(s.facts['accessory.product'].value).toBe('10EBU4151');
    expect(s.facts['accessory.model'].value).toBe('20EBU4101');
    expect(s.facts['phone.platform'].value).toBeNull();
    expect(s.facts['failure.stage'].value).toBe('connectivity-check');
  });

  it('versions are monotonic and never resurrect', () => {
    const s = fresh();
    const r0 = s.revision;
    setFact(s, 'phone.platform', 'ios', 'user-report');
    expect(s.facts['phone.platform'].version).toBe(1);
    expect(s.revision).toBe(r0 + 1);
    setFact(s, 'phone.platform', 'android', 'user-report');
    expect(s.facts['phone.platform'].version).toBe(2);
    setFact(s, 'phone.platform', 'ios', 'user-report');
    expect(s.facts['phone.platform'].version).toBe(3);
    expect(s.facts['phone.platform'].status).toBe('confirmed');
  });

  it('same value is a no-op', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'ios', 'user-report');
    const rev = s.revision;
    const r = setFact(s, 'phone.platform', 'ios', 'user-report');
    expect(r.changed).toBe(false);
    expect(s.facts['phone.platform'].version).toBe(1);
    expect(s.revision).toBe(rev);
  });

  it('typed confirmed value contradicted by a voice report becomes disputed', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'ios', 'typed');
    const r = setFact(s, 'phone.platform', 'android', 'user-report');
    expect(r.disputed).toBe(true);
    const f = s.facts['phone.platform'];
    expect(f.status).toBe('disputed');
    expect(f.value).toBe('ios');
    expect(s.notices.some((n) => n.kind === 'conflict')).toBe(true);
    resolveConflict(s, 'phone.platform', 'replace');
    expect(s.facts['phone.platform'].value).toBe('android');
    expect(s.facts['phone.platform'].status).toBe('confirmed');
  });

  it('keep resolution retains the typed value', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'ios', 'typed');
    setFact(s, 'phone.platform', 'android', 'user-report');
    resolveConflict(s, 'phone.platform', 'keep');
    expect(s.facts['phone.platform'].value).toBe('ios');
    expect(s.facts['phone.platform'].status).toBe('confirmed');
  });

  it('typed edit overrides a spoken value without conflict', () => {
    const s = fresh();
    setFact(s, 'phone.platform', 'ios', 'user-report');
    setFact(s, 'phone.platform', 'android', 'typed');
    expect(s.facts['phone.platform'].value).toBe('android');
    expect(s.notices).toHaveLength(0);
  });
});
