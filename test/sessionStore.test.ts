import { describe, it, expect } from 'vitest';
import { SessionStore } from '../src/tree/store.js';
import type { Session } from '../src/tree/types.js';

describe('SessionStore', () => {
  it('create/get round-trip', () => {
    const store = new SessionStore();
    const s = store.create();
    expect(store.get(s.id)).toBe(s);
    expect(store.get('nope')).toBeUndefined();
  });

  it('a session idle for 30 min + 1 ms is gone; activity keeps it', () => {
    let t = 1000;
    const store = new SessionStore(() => t);
    const a = store.create();
    const b = store.create();
    t += 30 * 60_000;
    expect(store.get(a.id)).toBe(a); // exactly 30 min is still alive, and get touches
    t += 30 * 60_000 + 1;
    expect(store.get(b.id)).toBeUndefined();
    expect(store.get(a.id)).toBeUndefined();
  });
});

describe('SessionStore ended sessions', () => {
  const ended = (store: SessionStore, s: Session, at: number) => store.end(s, { at, summary: null, shareId: 'sh' });

  it('an ended session outlives idle expiry and is found by share id for 24 h from ending', () => {
    let t = 1000;
    const store = new SessionStore(() => t);
    const s = store.create();
    ended(store, s, t);
    t += 24 * 3_600_000;
    expect(store.get(s.id)).toBe(s);
    expect(store.getByShareId('sh')).toBe(s);
    t += 1;
    expect(store.getByShareId('sh')).toBeUndefined();
    expect(store.get(s.id)).toBeUndefined();
  });

  it('getByShareId does not count as activity and ignores unknown ids', () => {
    let t = 1000;
    const store = new SessionStore(() => t);
    const s = store.create();
    expect(store.getByShareId('sh')).toBeUndefined();
    t += 10;
    ended(store, s, t);
    const before = s.lastActivity;
    t += 5;
    store.getByShareId('sh');
    expect(s.lastActivity).toBe(before);
  });
});
