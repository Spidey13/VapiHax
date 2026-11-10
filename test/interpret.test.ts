import { describe, it, expect } from 'vitest';
import { RuleInterpreter } from '../src/engine/interpret.js';
import { newCaseState, setFact } from '../src/case/facts.js';

const interp = new RuleInterpreter();
const fresh = (platform?: string) => {
  const s = newCaseState('s', 1, 0);
  if (platform) setFact(s, 'phone.platform', platform, 'user-report');
  return s;
};

describe('RuleInterpreter', () => {
  it("I'm pairing on my iPhone -> assertion ios", async () => {
    const r = await interp.interpret("I'm pairing on my iPhone", fresh());
    expect(r.kind).toBe('assertion');
    expect(r.facts).toEqual({ 'phone.platform': 'ios' });
  });

  it('Actually I am using my Android tablet -> correction android', async () => {
    const r = await interp.interpret("Actually I'm using my Android tablet", fresh('ios'));
    expect(r.kind).toBe('correction');
    expect(r.facts).toEqual({ 'phone.platform': 'android' });
  });

  it('hypothetical Android question yields no facts', async () => {
    const r = await interp.interpret('Would using an Android tablet help?', fresh('ios'));
    expect(r.kind).toBe('hypothetical');
    expect(r.facts).toBeUndefined();
    expect(r.hypotheticalFacts).toEqual({ 'phone.platform': 'android' });
  });

  it('Actually not the tablet, back to the iPhone -> correction ios', async () => {
    const r = await interp.interpret('Actually not the tablet, back to the iPhone', fresh('android'));
    expect(r.kind).toBe('correction');
    expect(r.facts).toEqual({ 'phone.platform': 'ios' });
  });

  it('negated platform mention is ignored', async () => {
    const r = await interp.interpret("it's not the android, it's the iPhone", fresh('android'));
    expect(r.facts).toEqual({ 'phone.platform': 'ios' });
  });

  it.each([
    ['I already tried that and it failed', 'failed'],
    ['it still failed', 'failed'],
    ["it didn't work", 'failed'],
    ["I haven't done that", 'not-started'],
    ['it worked', 'succeeded'],
    ['it paired', 'succeeded'],
    ['it paired and the plug turns on', 'succeeded'],
    ['it never paired', 'failed'],
  ])('%s -> attempt-report %s', async (text, outcome) => {
    const r = await interp.interpret(text, fresh('ios'));
    expect(r.kind).toBe('attempt-report');
    expect(r.attempt?.outcome).toBe(outcome);
    expect(r.facts).toBeUndefined();
  });

  it('an initial complaint is not an attempt report', async () => {
    const r = await interp.interpret("my Eve Energy won't pair, I'm on my iPhone", fresh());
    expect(r.kind).toBe('assertion');
    expect(r.attempt).toBeUndefined();
    expect(r.facts).toEqual({ 'phone.platform': 'ios' });
  });

  it('google services assertions', async () => {
    const yes = await interp.interpret('yes it has Google Play services', fresh('android'));
    expect(yes.facts).toEqual({ 'phone.googleServices': 'yes' });
    const no = await interp.interpret("no, it doesn't have Google services", fresh('android'));
    expect(no.facts).toEqual({ 'phone.googleServices': 'no' });
  });

  it('bare yes answers a pending google-services question only', async () => {
    const s = fresh('android');
    expect((await interp.interpret('yes', s)).facts).toBeUndefined();
    s.pendingQuestion = 'phone.googleServices';
    expect((await interp.interpret('yes', s)).facts).toEqual({ 'phone.googleServices': 'yes' });
  });

  it('sync outcomes become sync.status facts', async () => {
    expect((await interp.interpret('sync said success', fresh('android'))).facts).toEqual({ 'sync.status': 'reported-done' });
    expect((await interp.interpret('sync failed', fresh('android'))).facts).toEqual({ 'sync.status': 'failed' });
  });

  it('Apple TV variant', async () => {
    const r = await interp.interpret('My hub is an Apple TV 4K third gen, the 64 gig wifi one', fresh());
    expect(r.facts).toEqual({ 'hub.model': 'apple-tv-4k-3gen-64gb-wifi' });
  });

  it('"Eve plug" alone changes no accessory identifier; exact SKUs do', async () => {
    const vague = await interp.interpret('Eve plug', fresh());
    expect(vague.facts).toBeUndefined();
    expect(vague.kind).toBe('unknown');
    const exact = await interp.interpret('the label says 10EBU4151', fresh());
    expect(exact.facts).toEqual({ 'accessory.product': '10EBU4151' });
  });
});
