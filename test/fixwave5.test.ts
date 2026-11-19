import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import type Anthropic from '@anthropic-ai/sdk';
import { createApp, defaultDeps, type Deps } from '../src/server.js';
import { ClaudeSummarizer, listedBranchIds, normaliseSummary, summaryInput, type SessionSummary } from '../src/reply/summary.js';
import { summaryMarkdown } from '../src/view/summaryMarkdown.js';
import { buildMarkdown } from '../public/js/endLogic.js';
import { runTurn } from '../src/turn/pipeline.js';
import { TraceStore } from '../src/trace.js';
import { appendTurn, createSession, forkBranch, renameBranch, setStatus } from '../src/tree/tree.js';
import { correctedTrip } from './helpers/voiceScenarios.js';
import { fakeNamer, fakeResponder, fakeRouter, fakeSummarizer } from './helpers/fakes.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
const SECRET = 's';

function sample() {
  const s = createSession('s1', 0);
  appendTurn(s, 'b1', 'user', 'I want a podcast about bikes', 1);
  const b = forkBranch(s, 'b1', 'fork', 'live', 10);
  renameBranch(s, b.id, 'Newsletter idea');
  appendTurn(s, b.id, 'user', 'maybe a newsletter instead', 11);
  setStatus(s, b.id, 'faded', 12);
  return { s, b };
}

async function start(overrides: Partial<Deps> = {}) {
  const deps = defaultDeps({
    vapiSecret: SECRET,
    router: fakeRouter(),
    responder: fakeResponder(['Okay.']),
    namer: fakeNamer(null),
    summarizer: fakeSummarizer({ covered: 'c', branches: [], open: [] }),
    ...overrides,
  });
  const app = createApp(deps);
  const r = await request(app).post('/api/sessions').expect(201);
  const auth = { Authorization: `Bearer ${r.body.token}` };
  return { app, deps, id: r.body.sessionId as string, auth };
}
const shareIdOf = (url: string) => url.split('/s/')[1]!;

describe('C1 branch ids reach the summarizer', () => {
  it('summaryInput headers carry each listed id', () => {
    const { s, b } = sample();
    const out = summaryInput(s);
    expect(out).toContain('## [b1] Main (live)');
    expect(out).toContain(`## [${b.id}] Newsletter idea (faded)`);
  });
  it('the schema enum equals the listed ids and stays strict', async () => {
    const { s } = sample();
    const calls: any[] = [];
    const client = { messages: { create: async (r: unknown) => (calls.push(r), { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) } } as unknown as Anthropic;
    await new ClaudeSummarizer({ client }).summarize(s);
    const schema = calls[0].output_config.format.schema;
    const item = schema.properties.branches.items;
    expect(item.properties.id.enum).toEqual(listedBranchIds(s));
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['id', 'line']);
    expect(schema.additionalProperties).toBe(false);
    expect(calls[0].system).toMatch(/bracket/i);
    expect(schema.properties.considerations.items).toEqual({ type: 'string' });
  });
});

describe('M2/M3 normaliseSummary', () => {
  it('filters against the listed set, not every branch', () => {
    const { s } = sample();
    const empty = forkBranch(s, 'b1', 'fork', 'live', 20); // exists, but never spoken in
    const out = normaliseSummary(s, { covered: 'x', branches: [{ id: empty.id, line: 'ghost' }], open: [] });
    expect(out.branches.map((l) => l.id)).toEqual(listedBranchIds(s));
  });
  it('blank covered, open items and branch lines are replaced or dropped', () => {
    const { s, b } = sample();
    const out = normaliseSummary(s, { covered: '  ', branches: [{ id: 'b1', line: '   ' }, { id: b.id, line: 'Kept.' }], open: ['', ' ', 'Real?'] });
    expect(out.covered).toBe('Notes from your session.');
    expect(out.open).toEqual(['Real?']);
    expect(out.branches).toEqual([{ id: b.id, line: 'Kept.' }, { id: 'b1', line: 'Main: I want a podcast about bikes' }]);
  });
});

describe('M1 namer after end', () => {
  const ended = (s: any) => (s.ended = { at: 1, summary: null, shareId: 'x' });
  it('a fork namer resolving after end does not rename', async () => {
    const s = createSession('s', 0);
    let resolve!: (n: string) => void;
    const namer = { name: () => new Promise<string>((r) => (resolve = r)) };
    const res = await runTurn({ router: fakeRouter({ kind: 'fork', acknowledge: false }), responder: fakeResponder(['Ok.']), namer, traces: new TraceStore() }, s, 'a podcast');
    const before = s.branches[res.branchId]!.name;
    ended(s);
    resolve('Late name');
    await new Promise((r) => setTimeout(r, 5));
    expect(s.branches[res.branchId]!.name).toBe(before);
  });
  it('a merge namer resolving after end does not rename', async () => {
    const s = createSession('s', 0);
    forkBranch(s, 'b1', 'fork', 'live', 1);
    let resolve!: (n: string) => void;
    const namer = { name: () => new Promise<string>((r) => (resolve = r)) };
    await runTurn({ router: fakeRouter({ kind: 'merge', otherId: 'b1' }), responder: fakeResponder(['Ok.']), namer, traces: new TraceStore() }, s, 'combine them');
    const before = s.branches.b3!.name;
    ended(s);
    resolve('Late merge');
    await new Promise((r) => setTimeout(r, 5));
    expect(s.branches.b3!.name).toBe(before);
  });
});

describe('M4 ended sessions and the Vapi side', () => {
  it('events on an ended session start no speculation and bump no epoch; bind is 409', async () => {
    const { app, deps, id, auth } = await start();
    await request(app).post(`/api/sessions/${id}/bind`).set(auth).send({ callId: 'c1' }).expect(200);
    await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const epoch = deps.responseEpoch.get(id);
    const post = (m: object) => request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send({ message: { call: { id: 'c1' }, ...m } }).expect(200);
    await post({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'or a podcast' });
    await post({ type: 'user-interrupted' });
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.speculator!.runs).toBe(0);
    expect(deps.responseEpoch.get(id)).toBe(epoch);
    await request(app).post(`/api/sessions/${id}/bind`).set(auth).send({ callId: 'c2' }).expect(409);
    expect(deps.bindings.has('c2')).toBe(false);
  });
});

describe('M5 summary timeout aborts the call', () => {
  it('server passes an AbortSignal that aborts on timeout', async () => {
    let seen: AbortSignal | undefined;
    const hung = { async summarize(_s: unknown, signal?: AbortSignal) { seen = signal; return new Promise<never>(() => {}); } };
    const { app, id, auth } = await start({ summarizer: hung as any, summaryTimeoutMs: 20 });
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(true);
  });
  it('ClaudeSummarizer hands the signal to the SDK call', async () => {
    const { s } = sample();
    const opts: unknown[] = [];
    const client = { messages: { create: async (_r: unknown, o: unknown) => (opts.push(o), { stop_reason: 'end_turn', content: [] }) } } as unknown as Anthropic;
    const ac = new AbortController();
    await new ClaudeSummarizer({ client }).summarize(s, ac.signal);
    expect(opts[0]).toEqual({ signal: ac.signal });
  });
});

describe('M6 markdown escaping, M10 server/client parity', () => {
  const nasty: SessionSummary = {
    covered: '# Heading *bold* <b>x</b> [link](u) `code` _it_',
    branches: [{ id: 'b1', line: '- sneaky list' }],
    open: ['1. numbered', '> quote'],
  };
  it('escapes block markers and inline syntax on the server', () => {
    const { s } = sample();
    s.ended = { at: 1, summary: nasty, shareId: 'x' } as any;
    const md = summaryMarkdown(s);
    expect(md).toContain('\\# Heading \\*bold\\* \\<b>x\\</b> \\[link\\](u) \\`code\\` \\_it\\_');
    expect(md).toContain('- **Main**: \\- sneaky list');
    expect(md).toContain('- 1\\. numbered');
    expect(md).toContain('- \\> quote');
    expect(md).not.toMatch(/^# Heading/m);
  });
  it('client buildMarkdown matches the served summary.md for the same session', async () => {
    const { app, deps, id, auth } = await start({ summarizer: fakeSummarizer(nasty) });
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: '# a newsletter' }).expect(200);
    const e = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const share = await request(app).get(`/api/share/${shareIdOf(e.body.shareUrl)}`).expect(200);
    const md = await request(app).get(`/api/sessions/${id}/summary.md`).set(auth).expect(200);
    expect(buildMarkdown(share.body)).toBe(md.text);
    expect(deps.sessions.get(id)!.ended).toBeTruthy();
  });
});

describe('M7 unlisted ancestors are neutral', () => {
  it('shows an ellipsis instead of the ancestor name', async () => {
    const { app, deps, id, auth } = await start();
    const s = deps.sessions.get(id)!;
    s.branches.b1!.name = 'Secret scratched parent';
    const fork = forkBranch(s, 'b1', 'fork', 'live', Date.now());
    appendTurn(s, fork.id, 'user', 'spoken here', Date.now());
    const r = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const share = await request(app).get(`/api/share/${shareIdOf(r.body.shareUrl)}`).expect(200);
    expect(JSON.stringify(share.body)).not.toContain('Secret scratched parent');
    expect(share.body.map.nodes.find((n: any) => n.id === 'b1').label).toBe('…');
    expect(share.body.branches.find((b: any) => b.id === 'b1').name).toBe('…');
  });
});

describe('grounded notes: markdown and share payload', () => {
  const full: SessionSummary = { covered: 'Landed on Furano.', branches: [{ id: 'b1', line: 'Pick a city' }], considerations: ['Ski most mornings', 'Hot springs'], open: ['Which week?'] };
  const base = () => correctedTrip().session;
  it('server and client Markdown agree byte for byte, with and without optional sections', async () => {
    for (const summary of [full, { covered: 'c', branches: [], open: [] } as SessionSummary, { ...full, considerations: [], open: [] }]) {
      const { app, deps, id, auth } = await start({ summarizer: fakeSummarizer(summary) });
      await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
      const e = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
      const share = await request(app).get(`/api/share/${shareIdOf(e.body.shareUrl)}`).expect(200);
      const md = await request(app).get(`/api/sessions/${id}/summary.md`).set(auth).expect(200);
      expect(buildMarkdown(share.body)).toBe(md.text);
      expect(deps.sessions.get(id)!.ended).toBeTruthy();
    }
  });
  it('omits empty optional sections and handles an older summary without considerations', () => {
    const s = base();
    s.ended = { at: 1, summary: { covered: 'c', branches: [], open: [] }, shareId: 'x' } as any;
    expect(summaryMarkdown(s)).toBe('# Brainstorm summary\n\n## At a glance\n\nc\n');
    s.ended = { at: 1, summary: full, shareId: 'x' } as any;
    const md = summaryMarkdown(s);
    expect(md).toContain('## Worth keeping in mind\n\n- Ski most mornings\n- Hot springs\n');
    expect(md).toContain('## Still open\n\n- Which week?\n');
    expect(md).not.toMatch(/What you covered|Directions you explored/);
  });
  it('share branches carry origin; absorbed correction ancestors keep their real name, connectivity-only ancestors are neutral', async () => {
    const { app, deps, id, auth } = await start();
    const { session } = correctedTrip();
    const live = deps.sessions.get(id)!;
    Object.assign(live, { branches: session.branches, turns: session.turns, counters: session.counters, currentBranchId: session.currentBranchId });
    const e = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const share = await request(app).get(`/api/share/${shareIdOf(e.body.shareUrl)}`).expect(200);
    const byId = Object.fromEntries(share.body.branches.map((b: any) => [b.id, b]));
    expect(byId.b1.origin).toBe('root');
    expect(byId.b2.origin).toBe('fork');
    expect(byId.b2.name).toBe('Hokkaido ski trip');
    expect(byId.b3.origin).toBe('correction');
  });
});
