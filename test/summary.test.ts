import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeSummarizer, fallbackSummary, listedBranchIds, normaliseSummary, summaryInput } from '../src/reply/summary.js';
import { correctedMergedPlan, correctedTrip, sameNameTopics, workDecision } from './helpers/voiceScenarios.js';
import { appendTurn, createSession, forkBranch, renameBranch, scratchLast, setStatus } from '../src/tree/tree.js';

function sample() {
  const s = createSession('s1', 0);
  appendTurn(s, 'b1', 'user', 'I want a podcast about bikes', 1);
  appendTurn(s, 'b1', 'assistant', 'Who listens?', 2);
  appendTurn(s, 'b1', 'user', 'oops wrong thing', 3);
  scratchLast(s, 'b1');
  const b = forkBranch(s, 'b1', 'fork', 'live', 10);
  renameBranch(s, b.id, 'Newsletter idea');
  appendTurn(s, b.id, 'user', 'maybe a newsletter instead', 11);
  setStatus(s, b.id, 'faded', 12);
  const empty = forkBranch(s, 'b1', 'fork', 'live', 13);
  renameBranch(s, empty.id, 'Silent');
  return { s, b, empty };
}

function fake(result: unknown, calls: any[] = []): Anthropic {
  return {
    messages: {
      create: async (req: unknown) => {
        calls.push(req);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  } as unknown as Anthropic;
}
const textRes = (text: string, stop_reason = 'end_turn') => ({
  stop_reason,
  content: [{ type: 'text', text }],
});

describe('summaryInput', () => {
  it('lists each branch with user turns once, excluding scratched turns and empty branches', () => {
    const { s } = sample();
    const out = summaryInput(s);
    expect(out.match(/^## /gm)).toHaveLength(2);
    expect(out).toContain('## [b1] Main (live)');
    expect(out).toContain('] Newsletter idea (faded)');
    expect(out).toContain('User: I want a podcast about bikes');
    expect(out).toContain('Assistant: Who listens?');
    expect(out).not.toContain('oops wrong thing');
    expect(out).not.toContain('Silent');
  });
  it('uses only each branch own turns', () => {
    const { s } = sample();
    const out = summaryInput(s);
    const nl = out.slice(out.indexOf('## Newsletter idea'));
    expect(nl).not.toContain('podcast');
  });
});

describe('fallbackSummary', () => {
  it('builds one line per branch from its last non-scratched user line', () => {
    const { s, b } = sample();
    const f = fallbackSummary(s);
    expect(f.covered).toBe('Notes from your session.');
    expect(f.open).toEqual([]);
    expect(f.branches).toEqual([
      { id: 'b1', line: 'Main: I want a podcast about bikes' },
      { id: b.id, line: 'Newsletter idea: maybe a newsletter instead' },
    ]);
  });
});

describe('ClaudeSummarizer', () => {
  const valid = {
    covered: 'You weighed a podcast.',
    branches: [{ id: 'b1', line: 'Main: podcast' }],
    considerations: ['Keep it weekly'],
    open: ['Who listens?'],
  };
  it('requests structured output with the required schema', async () => {
    const calls: any[] = [];
    const { s } = sample();
    await new ClaudeSummarizer({ client: fake(textRes(JSON.stringify(valid)), calls) }).summarize(s);
    const fmt = calls[0].output_config.format;
    expect(fmt.type).toBe('json_schema');
    expect(fmt.schema.required).toEqual(['covered', 'branches', 'considerations', 'open']);
    expect(calls[0].output_config.effort).toBe('low');
    expect(calls[0].max_tokens).toBe(2000);
  });
  it('parses valid JSON', async () => {
    const { s } = sample();
    const r = await new ClaudeSummarizer({ client: fake(textRes(JSON.stringify(valid))) }).summarize(s);
    expect(r).toEqual(valid);
  });
  it('accepts a payload without considerations as an empty list', async () => {
    const { s } = sample();
    const { considerations: _c, ...old } = valid;
    const r = await new ClaudeSummarizer({ client: fake(textRes(JSON.stringify(old))) }).summarize(s);
    expect(r).toEqual({ ...old, considerations: [] });
  });
  it('asks for grounded notes: reasons, considerations, no invented decisions', async () => {
    const calls: any[] = [];
    const { s } = sample();
    await new ClaudeSummarizer({ client: fake(textRes(JSON.stringify(valid)), calls) }).summarize(s);
    const sys: string = calls[0].system;
    expect(sys).toMatch(/where they landed/i);
    expect(sys).toMatch(/reasons/i);
    expect(sys).toMatch(/Suggested:/);
    expect(sys).toMatch(/never invent/i);
    expect(calls[0].output_config.format.schema.properties.considerations.type).toBe('array');
  });
  it.each([
    ['invalid JSON', textRes('not json')],
    ['wrong shape', textRes(JSON.stringify({ covered: 'x' }))],
    ['empty output', { stop_reason: 'end_turn', content: [] }],
    ['max_tokens', textRes(JSON.stringify(valid), 'max_tokens')],
    ['thrown error', new Error('boom')],
  ])('falls back on %s', async (_n, res) => {
    const { s } = sample();
    const r = await new ClaudeSummarizer({ client: fake(res) }).summarize(s);
    expect(r).toEqual(fallbackSummary(s));
  });
});

describe('logical topics in the summary', () => {
  it('a correction chain is one topic with every source detail and a correction label', () => {
    const { session, cityId, correctedId } = correctedTrip();
    const out = summaryInput(session);
    expect(out.match(/^## /gm)).toHaveLength(2);
    expect(out).toContain(`## [${correctedId}] Hokkaido ski trip (live)`);
    expect(out).toContain('User: a small ryokan');
    expect(out).toContain('User (correction): Furano, not Niseko');
    expect(out).toContain('Assistant: A ryokan near Niseko works.');
    expect(listedBranchIds(session)).toEqual([cityId, correctedId]);
  });
  it('same-named forks remain separate topics', () => {
    expect(summaryInput(sameNameTopics()).match(/Dinner party/g)).toHaveLength(2);
    expect(listedBranchIds(sameNameTopics())).toHaveLength(3);
  });
  it('a merged topic carries source digests and the combined note under its header', () => {
    const { session, correctedId } = correctedMergedPlan();
    const out = summaryInput(session);
    const block = out.slice(out.indexOf(`## [${correctedId}]`));
    expect(block).toContain('Note: Thread "Mountain week": SOURCE-DIGEST-ALPHA');
    expect(block).toContain('Note: Combined from "Mountain week" and "Coast week".');
    expect(block.indexOf('Note:')).toBeLessThan(block.indexOf('User:'));
  });
  it('the work fixture keeps the reason, the constraint and the unaccepted suggestion in the input', () => {
    const out = summaryInput(workDecision());
    expect(out).toContain('User: fix onboarding first, because new users are dropping off');
    expect(out).toContain('User: it has to ship before the end of the month');
    expect(out).toContain('Assistant: You could also rewrite the whole backend.');
  });
  it('fallback lists one line per topic with its whole corrected plan and invents nothing', () => {
    const { session, correctedId } = correctedTrip();
    const f = fallbackSummary(session);
    expect(f.branches.find((l) => l.id === correctedId)!.line).toBe('Hokkaido ski trip: snow and hot springs Hokkaido a small ryokan ski most mornings Furano, not Niseko');
    expect(f.branches).toHaveLength(2);
    expect(f.considerations ?? []).toEqual([]);
    expect(f.open).toEqual([]);
  });
  it('normaliseSummary trims, dedupes case-insensitively and caps considerations at 4 and open at 3', () => {
    const { session } = correctedTrip();
    const out = normaliseSummary(session, {
      covered: ' x ',
      branches: [],
      considerations: [' Snow ', 'snow', '', 'a', 'b', 'c', 'd'],
      open: ['q1', 'Q1', ' ', 'q2', 'q3', 'q4'],
    });
    expect(out.considerations).toEqual(['Snow', 'a', 'b', 'c']);
    expect(out.open).toEqual(['q1', 'q2', 'q3']);
    expect(out.covered).toBe('x');
  });
  it('an older payload without considerations normalises to an empty list', () => {
    const { session } = correctedTrip();
    expect(normaliseSummary(session, { covered: 'x', branches: [], open: [] }).considerations).toEqual([]);
  });
  it('drops lines for absorbed ancestors and unknown ids', () => {
    const { session, snowId, correctedId } = correctedTrip();
    const out = normaliseSummary(session, { covered: 'x', branches: [{ id: snowId, line: 'old' }, { id: correctedId, line: 'Furano.' }], open: [] });
    expect(out.branches.map((l) => l.id)).toEqual([correctedId, 'b1']);
  });
});
