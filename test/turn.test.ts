import { describe, it, expect } from 'vitest';
import { CaseStore } from '../src/case/store.js';
import { setFact } from '../src/case/facts.js';
import { RuleInterpreter } from '../src/engine/interpret.js';
import { handleTurn } from '../src/engine/turn.js';
import { isStillCurrent } from '../src/engine/respond.js';

const interp = new RuleInterpreter();
const mk = () => new CaseStore().createCase();
const say = (s: ReturnType<typeof mk>, t: string) => handleTurn(s, t, 'text', interp);

describe('handleTurn journey 2', () => {
  it('issues ios check', async () => {
    const s = mk();
    const r = await say(s, "my Eve Energy won't pair, I'm on my iPhone");
    expect(s.currentCheck?.check.id).toBe('ios-credential-sync');
    expect(r.reply).toContain(s.currentCheck!.check.expectedObservation);
  });

  it('correction supersedes iphone step; asks google services; then android check', async () => {
    const s = mk();
    await say(s, "my Eve Energy won't pair, I'm on my iPhone");
    const before = s.facts['phone.platform'].version;
    const oldStamp = s.currentCheck!.stamp;
    const accBefore = JSON.stringify(s.facts['accessory.model']);
    const r = await say(s, "Actually I'm using my Android tablet");
    expect(s.facts['phone.platform'].version).toBe(before + 1);
    expect(s.notices.some((n) => n.kind === 'superseded' && /iPhone step no longer applies/.test(n.text))).toBe(true);
    expect(JSON.stringify(s.facts['accessory.model'])).toBe(accBefore);
    expect(r.reply.toLowerCase()).toContain('google play services');
    expect(s.currentCheck).toBeNull();
    expect(isStillCurrent(s, oldStamp)).toBe(false);
    await say(s, 'yes, Google services');
    expect(s.currentCheck?.check.id).toBe('android-credential-sync');
  });

  it('keeps superseded attempts but marks them not applicable', async () => {
    const s = mk();
    await say(s, "I'm on my iPhone");
    await say(s, 'I already tried that and it failed');
    expect(s.attempts[0].applicable).toBe(true);
    await say(s, "Actually I'm using my Android tablet");
    expect(s.attempts.length).toBe(1);
    expect(s.attempts[0].applicable).toBe(false);
  });

  it('hypothetical does not change facts or branch', async () => {
    const s = mk();
    await say(s, "I'm on my iPhone");
    const v = s.facts['phone.platform'].version;
    const r = await say(s, 'Would an Android tablet help?');
    expect(s.facts['phone.platform'].value).toBe('ios');
    expect(s.facts['phone.platform'].version).toBe(v);
    expect(s.hypothetical).toEqual({ 'phone.platform': 'android' });
    expect(s.notices.some((n) => n.kind === 'hypothetical')).toBe(true);
    expect(s.currentCheck?.check.id).toBe('ios-credential-sync');
    expect(r.reply).toContain('what-if');
  });

  it('failed report is recorded and not repeated', async () => {
    const s = mk();
    await say(s, "I'm on my iPhone");
    await say(s, 'I already tried that and it failed');
    expect(s.attempts.at(-1)).toMatchObject({ checkId: 'ios-credential-sync', outcome: 'failed' });
    expect(s.currentCheck?.check.id).not.toBe('ios-credential-sync');
  });

  it('sync success then retry failure -> unresolved with handoff text', async () => {
    const s = mk();
    await say(s, "I'm on my iPhone");
    await say(s, 'sync said success');
    expect(s.currentCheck?.check.id).toBe('retry-pairing-once');
    const r = await say(s, 'it still failed');
    expect(s.outcome).toBe('unresolved');
    expect(r.reply.toLowerCase()).toContain('hand');
  });

  it('paired -> user-reported-recovered, never "fixed"', async () => {
    const s = mk();
    await say(s, "I'm on my iPhone");
    await say(s, 'sync said success');
    const r = await say(s, 'it paired and the plug turns on');
    expect(s.outcome).toBe('user-reported-recovered');
    expect(r.reply.toLowerCase()).not.toMatch(/\bfixed\b|network healthy/);
  });

  it('typed-vs-voice conflict withholds advice until resolved', async () => {
    const s = mk();
    setFact(s, 'phone.platform', 'ios', 'typed');
    await say(s, 'I am on my Android phone');
    expect(s.facts['phone.platform'].status).toBe('disputed');
    expect(s.currentCheck).toBeNull();
    await say(s, 'use what I said');
    expect(s.facts['phone.platform'].value).toBe('android');
    expect(s.facts['phone.platform'].status).toBe('confirmed');
  });
});

describe('sync/platform interplay', () => {
  it('plain worked on a sync check sets sync done and moves to retry', async () => {
    const s = mk();
    await say(s, "I'm on my iPhone");
    await say(s, 'it worked');
    expect(s.facts['sync.status'].value).toBe('reported-done');
    expect(s.attempts.filter((a) => a.checkId === 'ios-credential-sync')).toHaveLength(1);
    expect(s.currentCheck?.check.id).toBe('retry-pairing-once');
  });

  it('platform change clears phone-specific sync status', async () => {
    const s = mk();
    await say(s, "I'm on my iPhone");
    await say(s, 'I tried that and it failed');
    expect(s.facts['sync.status'].value).toBe('failed');
    await say(s, "Actually I'm using my Android tablet");
    expect(s.facts['sync.status'].value).toBeNull();
    await say(s, 'yes, Google services');
    expect(s.currentCheck?.check.id).toBe('android-credential-sync');
  });
});
