import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, defaultDeps, type Deps } from '../src/server.js';
import { SessionStore } from '../src/tree/store.js';
import type { Session } from '../src/tree/types.js';
import { forkBranch, appendTurn } from '../src/tree/tree.js';
import { normaliseSummary } from '../src/reply/summary.js';
import { fakeRouter, fakeResponder, fakeNamer, fakeSummarizer } from './helpers/fakes.js';

const SUMMARY = { covered: 'You weighed a newsletter.', branches: [{ id: 'b1', line: 'Newsletter: leaning yes.' }], considerations: ['Pricing matters most.'], open: ['Pricing?'] };

async function start(overrides: Partial<Deps> = {}) {
  const deps = defaultDeps({
    vapiSecret: 's',
    router: fakeRouter(),
    responder: fakeResponder(['Okay.']),
    namer: fakeNamer(null),
    summarizer: fakeSummarizer(SUMMARY),
    ...overrides,
  });
  const app = createApp(deps);
  const r = await request(app).post('/api/sessions').expect(201);
  const auth = { Authorization: `Bearer ${r.body.token}` };
  return { app, deps, id: r.body.sessionId as string, token: r.body.token as string, auth };
}
const shareIdOf = (url: string) => url.split('/s/')[1]!;

describe('end session', () => {
  it('ending an empty session: no summarizer call, share JSON says nothing to summarise', async () => {
    const sum = fakeSummarizer(SUMMARY);
    const { app, id, auth } = await start({ summarizer: sum });
    const r = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    expect(sum.calls).toEqual([]);
    expect(r.body.state.ended.shareUrl).toBe(r.body.shareUrl);
    const share = await request(app).get(`/api/share/${shareIdOf(r.body.shareUrl)}`).expect(200);
    expect(share.body.nothing).toBe(true);
    expect(share.body.summary).toBeNull();
    expect(share.body.showMap).toBe(false);
  });

  it('ending twice returns the same share link and summarises once', async () => {
    const sum = fakeSummarizer(SUMMARY);
    const { app, id, auth } = await start({ summarizer: sum });
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    const a = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const b = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    expect(shareIdOf(b.body.shareUrl)).toBe(shareIdOf(a.body.shareUrl));
    expect(sum.calls).toHaveLength(1);
    expect(a.body.shareUrl).toMatch(/\/s\/[0-9a-f]{32}$/);
  });

  it('end needs the session token', async () => {
    const { app, id } = await start();
    await request(app).post(`/api/sessions/${id}/end`).expect(401);
  });

  it('a summarizer that throws still ends with a fallback summary', async () => {
    const { app, id, auth } = await start({ summarizer: fakeSummarizer(new Error('boom')) });
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    const r = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const share = await request(app).get(`/api/share/${shareIdOf(r.body.shareUrl)}`).expect(200);
    expect(share.body.summary.branches[0].line).toContain('a newsletter');
  });

  it('share JSON needs no token and contains neither the session id nor the token', async () => {
    const { app, id, token, auth } = await start();
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    const r = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const share = await request(app).get(`/api/share/${shareIdOf(r.body.shareUrl)}`).expect(200);
    const text = JSON.stringify(share.body);
    expect(text).not.toContain(id);
    expect(text).not.toContain(token);
    expect(Object.keys(share.body).sort()).toEqual(['branches', 'endedAt', 'map', 'nothing', 'showMap', 'summary']);
  });

  it('showMap is false with one branch and true with two', async () => {
    const one = await start({ router: fakeRouter({ kind: 'continue' }) });
    await request(one.app).post(`/api/sessions/${one.id}/turn`).set(one.auth).send({ text: 'a newsletter' }).expect(200);
    const e1 = await request(one.app).post(`/api/sessions/${one.id}/end`).set(one.auth).expect(200);
    expect((await request(one.app).get(`/api/share/${shareIdOf(e1.body.shareUrl)}`)).body.showMap).toBe(false);

    const two = await start({ router: fakeRouter({ kind: 'continue' }, { kind: 'fork', acknowledge: false }) });
    await request(two.app).post(`/api/sessions/${two.id}/turn`).set(two.auth).send({ text: 'a newsletter' }).expect(200);
    await request(two.app).post(`/api/sessions/${two.id}/turn`).set(two.auth).send({ text: 'or a podcast?' }).expect(200);
    const e2 = await request(two.app).post(`/api/sessions/${two.id}/end`).set(two.auth).expect(200);
    const share = await request(two.app).get(`/api/share/${shareIdOf(e2.body.shareUrl)}`).expect(200);
    expect(share.body.showMap).toBe(true);
    expect(share.body.map.nodes).toHaveLength(2);
  });

  it('unknown or malformed share ids are 404, for the page and the JSON', async () => {
    const { app } = await start();
    await request(app).get(`/api/share/${'0'.repeat(32)}`).expect(404);
    await request(app).get('/api/share/nope').expect(404);
    await request(app).get(`/s/${'0'.repeat(32)}`).expect(404);
  });

  it('the share page is served for a live share id, with no-referrer', async () => {
    const { app, id, auth } = await start();
    const r = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const page = await request(app).get(`/s/${shareIdOf(r.body.shareUrl)}`).expect(200);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.text).toContain('endPage.js');
  });

  it('share links die 24 h + 1 ms after ending; exactly 24 h is still alive', async () => {
    let t = 1_000_000;
    const sessions = new SessionStore(() => t);
    const { app, id, auth } = await start({ sessions, now: () => t });
    const r = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const sid = shareIdOf(r.body.shareUrl);
    t += 24 * 3_600_000;
    await request(app).get(`/api/share/${sid}`).expect(200);
    t += 1;
    await request(app).get(`/api/share/${sid}`).expect(404);
    await request(app).get(`/s/${sid}`).expect(404);
  });

  it('summary.md has the four headings in order and downloads as an attachment', async () => {
    const { app, id, auth } = await start();
    await request(app).get(`/api/sessions/${id}/summary.md`).set(auth).expect(409); // not ended yet
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const r = await request(app).get(`/api/sessions/${id}/summary.md`).set(auth).expect(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment/);
    const i = ['## At a glance', '## Topics', '## Worth keeping in mind', '## Still open'].map((h) => r.text.indexOf(h));
    expect(i.every((x) => x >= 0)).toBe(true);
    expect([...i].sort((a, b) => a - b)).toEqual(i);
    expect(r.text).toContain('Pricing?');
    await request(app).get(`/api/sessions/${id}/summary.md`).expect(401);
  });

  it('turn, switch and hold after ending are 409, and nothing is recorded', async () => {
    const { app, id, auth } = await start();
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'more' }).expect(409);
    await request(app).post(`/api/sessions/${id}/switch`).set(auth).send({ branchId: 'b1' }).expect(409);
    await request(app).post(`/api/sessions/${id}/hold`).set(auth).send({ hold: true }).expect(409);
    const st = await request(app).get(`/api/sessions/${id}`).set(auth).expect(200);
    expect(st.body.path.map((t: { text: string }) => t.text)).toEqual(['a newsletter', 'Okay.']);
    expect(st.body.hold).toBe(false);
    expect(st.body.ended.shareUrl).toMatch(/\/s\//);
  });

  it('ending mid-answer stores only the spoken part of the last reply before the notes are written', async () => {
    const long = 'A week split between Tokyo and Kyoto works well. Winter keeps the crowds light.';
    const lastSeen: string[] = [];
    const sum = { async summarize(s: Session) { lastSeen.push(s.turns.filter((t) => t.role === 'assistant').at(-1)?.text ?? ''); return SUMMARY; } };
    const { app, deps, id, auth } = await start({ summarizer: sum, responder: fakeResponder([long]) });
    await request(app).post(`/api/sessions/${id}/bind`).set(auth).send({ callId: 'c1' }).expect(200);
    await request(app).post('/vapi/chat/completions').set('x-vapi-secret', 's').send({ call: { id: 'c1' }, stream: true, messages: [{ role: 'user', content: 'a week in Japan' }] }).expect(200);
    const event = (message: Record<string, unknown>) =>
      request(app).post('/vapi/events').set('x-vapi-secret', 's').send({ message: { call: { id: 'c1' }, ...message } }).expect(200);
    await event({ type: 'speech-update', role: 'assistant', status: 'started', turn: 1 });
    await event({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'A week split' });
    await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const s = deps.sessions.get(id)!;
    expect(s.turns.filter((t) => t.role === 'assistant').map((t) => t.text)).toEqual(['A week split']);
    expect(lastSeen).toEqual(['A week split']);
  });

  it('the Vapi endpoint on an ended session streams an empty completion and records nothing', async () => {
    const { app, id, auth } = await start();
    await request(app).post(`/api/sessions/${id}/bind`).set(auth).send({ callId: 'c1' }).expect(200);
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const r = await request(app)
      .post('/vapi/chat/completions')
      .set('x-vapi-secret', 's')
      .send({ call: { id: 'c1' }, stream: true, messages: [{ role: 'user', content: 'a newsletter' }, { role: 'assistant', content: 'Ok' }, { role: 'user', content: 'and more' }] })
      .expect(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.text.trim().endsWith('data: [DONE]')).toBe(true);
    expect(r.text).toContain('"content":""');
    expect(r.text).not.toContain('Okay');
    const st = await request(app).get(`/api/sessions/${id}`).set(auth).expect(200);
    expect(st.body.path.map((t: { text: string }) => t.text)).toEqual(['a newsletter', 'Okay.']);
  });
});

describe('share payload scope and timing', () => {
  it('a fork whose only user turn was scratched is not in the map, the branches, or the JSON', async () => {
    const { app, deps, id, auth } = await start();
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    const s = deps.sessions.get(id)!;
    const fork = forkBranch(s, 'b1', 'fork', 'live', Date.now());
    fork.name = 'Secret scratched idea';
    appendTurn(s, fork.id, 'user', 'secret scratched text', Date.now()).scratched = true;
    const r = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const share = await request(app).get(`/api/share/${shareIdOf(r.body.shareUrl)}`).expect(200);
    expect(share.body.showMap).toBe(false);
    expect(share.body.map.nodes.map((n: { id: string }) => n.id)).toEqual(['b1']);
    expect(JSON.stringify(share.body)).not.toContain('Secret scratched idea');
  });

  it('a listed fork keeps its unlisted parent so the tree stays connected', async () => {
    const { app, deps, id, auth } = await start();
    const s = deps.sessions.get(id)!;
    const fork = forkBranch(s, 'b1', 'fork', 'live', Date.now());
    appendTurn(s, fork.id, 'user', 'spoken here', Date.now());
    const r = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const share = await request(app).get(`/api/share/${shareIdOf(r.body.shareUrl)}`).expect(200);
    expect(share.body.map.nodes).toHaveLength(2);
    expect(share.body.map.edges).toEqual([{ from: 'b1', to: fork.id }]);
  });

  it('a hung summarizer falls back after the timeout instead of holding the lock', async () => {
    const hung = { async summarize() { return new Promise<never>(() => {}); } };
    const { app, id, auth } = await start({ summarizer: hung, summaryTimeoutMs: 20 });
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    const r = await request(app).post(`/api/sessions/${id}/end`).set(auth).expect(200);
    const share = await request(app).get(`/api/share/${shareIdOf(r.body.shareUrl)}`).expect(200);
    expect(share.body.summary.branches[0].line).toContain('a newsletter');
  });

  it('two concurrent ends call a slow summarizer once and return the same share id', async () => {
    const calls: string[] = [];
    const slow = {
      async summarize() {
        calls.push('x');
        await new Promise((r) => setTimeout(r, 50));
        return SUMMARY;
      },
    };
    const { app, id, auth } = await start({ summarizer: slow });
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    const [a, b] = await Promise.all([
      request(app).post(`/api/sessions/${id}/end`).set(auth),
      request(app).post(`/api/sessions/${id}/end`).set(auth),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(shareIdOf(a.body.shareUrl)).toBe(shareIdOf(b.body.shareUrl));
  });
});

describe('normaliseSummary', () => {
  it('drops unknown ids and repeats, fills missing listed branches, caps considerations at 4 and open at 3', async () => {
    const { deps, id, app, auth } = await start();
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    const s = deps.sessions.get(id)!;
    const out = normaliseSummary(s, {
      covered: 'c',
      branches: [{ id: 'zzz', line: 'ghost' }, { id: 'constructor', line: 'proto' }],
      considerations: ['c1', 'c2', 'c3', 'c4', 'c5'],
      open: ['1', '2', '3', '4', '5', '6', '7'],
    });
    expect(out.branches.map((b) => b.id)).toEqual(['b1']);
    expect(out.branches[0]!.line).toContain('a newsletter');
    expect(out.considerations).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(out.open).toEqual(['1', '2', '3']);
  });
});
