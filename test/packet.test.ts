import { describe, it, expect } from 'vitest';
import { CaseStore } from '../src/case/store.js';
import { RuleInterpreter } from '../src/engine/interpret.js';
import { handleTurn } from '../src/engine/turn.js';
import { toJson, toMarkdown } from '../src/packet.js';

const interp = new RuleInterpreter();
const say = (s: ReturnType<CaseStore['createCase']>, t: string) => handleTurn(s, t, 'text', interp);

async function journey() {
  const s = new CaseStore().createCase();
  await say(s, "I'm on my iPhone");
  await say(s, 'I already tried that and it failed');
  await say(s, "Actually I'm using my Android tablet");
  return s;
}

describe('packet', () => {
  it('markdown has banner, identity, attempts, sources and honest wording', async () => {
    const s = await journey();
    const md = toMarkdown(s);
    expect(md.startsWith('**EXAMPLE CASE — synthetic household; not a recovered real device**')).toBe(true);
    expect(md).toContain('accessory.firmware: unknown');
    expect(md).toMatch(/ios-credential-sync: failed — no longer applicable/);
    expect(md).toContain('curated 2026-11-09');
    expect(md).toContain('https://www.home-assistant.io/integrations/thread/');
    expect(md).toContain('Next action');
    expect(md.toLowerCase()).not.toMatch(/\bfixed\b|network healthy/);
  });

  it('json mirrors the same fields and recovered stays user-reported', async () => {
    const s = await journey();
    const j = toJson(s);
    expect(j.banner).toContain('EXAMPLE CASE');
    expect(j.attempts[0].applicable).toBe(false);
    expect(j.sources.length).toBeGreaterThan(0);
    await say(s, 'yes, Google services');
    const s2 = new CaseStore().createCase();
    await say(s2, "I'm on my iPhone");
    await say(s2, 'sync said success');
    await say(s2, 'it paired and the plug turns on');
    expect(toJson(s2).outcome.label).toContain('User-reported');
    expect(JSON.stringify(toJson(s2)).toLowerCase()).not.toMatch(/\bfixed\b|network healthy/);
  });
});
