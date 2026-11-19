import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp, defaultDeps, type Deps } from '../src/server.js';
import { userTextSinceLastAssistant } from '../src/vapi/customLlm.js';
import { fakeRouter, fakeResponder, fakeNamer, gatedResponder } from './helpers/fakes.js';

const SECRET = 'test-secret';
vi.spyOn(console, 'log').mockImplementation(() => {});

async function setup(overrides: Partial<Deps> = {}) {
  const deps = defaultDeps({ vapiSecret: SECRET, router: fakeRouter(), responder: fakeResponder(['Reply.']), namer: fakeNamer(null), ...overrides });
  const app = createApp(deps);
  const r = await request(app).post('/api/sessions');
  const auth = { Authorization: `Bearer ${r.body.token}` };
  await request(app).post(`/api/sessions/${r.body.sessionId}/bind`).set(auth).send({ callId: 'call-A' }).expect(200);
  return { app, deps, auth, id: r.body.sessionId as string };
}

const msgs = (...m: [string, string][]) => ({ call: { id: 'call-A' }, messages: m.map(([role, content]) => ({ role, content })) });
const sse = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => cb(null, d));
  });

describe('hold route', () => {
  it('defaults false, toggles, and is exposed in state', async () => {
    const { app, auth, id } = await setup();
    expect((await request(app).get(`/api/sessions/${id}`).set(auth)).body.hold).toBe(false);
    const r = await request(app).post(`/api/sessions/${id}/hold`).set(auth).send({ hold: true }).expect(200);
    expect(r.body.state.hold).toBe(true);
    const r2 = await request(app).post(`/api/sessions/${id}/hold`).set(auth).send({ hold: false }).expect(200);
    expect(r2.body.state.hold).toBe(false);
  });

  it('400 on a non-boolean body, 401 without a token', async () => {
    const { app, auth, id } = await setup();
    await request(app).post(`/api/sessions/${id}/hold`).set(auth).send({ hold: 'yes' }).expect(400);
    await request(app).post(`/api/sessions/${id}/hold`).set(auth).send({}).expect(400);
    await request(app).post(`/api/sessions/${id}/hold`).send({ hold: true }).expect(401);
  });
});

describe('completions while held', () => {
  it('non-stream: empty assistant message, nothing recorded', async () => {
    const { app, deps, auth, id } = await setup();
    await request(app).post(`/api/sessions/${id}/hold`).set(auth).send({ hold: true }).expect(200);
    const r = await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(msgs(['user', 'so'])).expect(200);
    expect(r.body.choices[0].message.content).toBe('');
    expect(deps.sessions.get(id)!.turns).toHaveLength(0);
  });

  it('stream: one empty content chunk then [DONE], nothing recorded', async () => {
    const { app, deps, auth, id } = await setup();
    await request(app).post(`/api/sessions/${id}/hold`).set(auth).send({ hold: true }).expect(200);
    const r = await sse(request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ ...msgs(['user', 'so']), stream: true })).expect(200);
    const text = r.body as string;
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    const events = text.split('\n\n').filter((e) => e.startsWith('data: {')).map((e) => JSON.parse(e.slice(6)));
    expect(events.map((e) => e.choices[0].delta.content ?? '').join('')).toBe('');
    expect(events.filter((e) => e.choices[0].delta.content === '')).toHaveLength(1);
    expect(deps.sessions.get(id)!.turns).toHaveLength(0);
  });

  it('after release, held speech after an empty assistant reply is one user turn', async () => {
    const { app, deps, id } = await setup();
    await request(app)
      .post('/vapi/chat/completions')
      .set('x-vapi-secret', SECRET)
      .send(msgs(['user', 'so'], ['assistant', ''], ['user', 'the newsletter'], ['user', 'could be weekly']))
      .expect(200);
    const turns = deps.sessions.get(id)!.turns;
    expect(turns[0]!.text).toBe('so the newsletter could be weekly');
  });

  it('end to end: held completion is silent, then release answers the combined segments once', async () => {
    const { app, deps, auth, id } = await setup();
    const post = (m: object) => request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(m).expect(200);
    await request(app).post(`/api/sessions/${id}/hold`).set(auth).send({ hold: true }).expect(200);
    const held = await post(msgs(['user', 'so']));
    expect(held.body.choices[0].message.content).toBe('');
    expect(deps.sessions.get(id)!.turns).toHaveLength(0);
    await request(app).post(`/api/sessions/${id}/hold`).set(auth).send({ hold: false }).expect(200);
    const r = await post(msgs(['user', 'so'], ['assistant', ''], ['user', 'the newsletter']));
    expect(r.body.choices[0].message.content).toBe('Reply.');
    expect(deps.sessions.get(id)!.turns.map((t) => [t.role, t.text])).toEqual([['user', 'so the newsletter'], ['assistant', 'Reply.']]);
  });

  it('a hold that lands while the request is queued behind the lock keeps it silent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { app, deps, id } = await setup({ responder: gatedResponder(['One.'], gate) });
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/vapi/chat/completions`;
      const go = (text: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET }, body: JSON.stringify(msgs(['user', text])) });
      const first = go('hello');
      await vi.waitFor(() => expect(deps.sessions.get(id)!.turns.length).toBeGreaterThan(0));
      const second = go('and then');
      await new Promise((r) => setTimeout(r, 50));
      deps.sessions.get(id)!.hold = true;
      release();
      const r2 = await (await second).json();
      await first;
      expect(r2.choices[0].message.content).toBe('');
      expect(deps.sessions.get(id)!.turns.map((t) => t.text)).toEqual(['hello', 'One.']);
    } finally {
      release();
      server.close();
    }
  });

  it('release with no user text since the last assistant reply: no reply, no turn', async () => {
    const { app, deps, id } = await setup();
    const r = await request(app)
      .post('/vapi/chat/completions')
      .set('x-vapi-secret', SECRET)
      .send(msgs(['user', 'hi'], ['assistant', 'Hello there.']))
      .expect(200);
    expect(r.body.choices[0].message.content).toBe('');
    expect(deps.sessions.get(id)!.turns).toHaveLength(0);
  });
});

describe('userTextSinceLastAssistant', () => {
  it('joins user messages after the last non-empty assistant message', () => {
    const b = msgs(['user', 'old'], ['assistant', 'ok'], ['user', 'so'], ['assistant', '  '], ['user', 'the newsletter'], ['user', 'could be weekly']);
    expect(userTextSinceLastAssistant(b)).toBe('so the newsletter could be weekly');
  });
  it('caps at 1000 chars and tolerates junk', () => {
    expect(userTextSinceLastAssistant(msgs(['user', 'x'.repeat(2000)]))).toHaveLength(1000);
    expect(userTextSinceLastAssistant(null)).toBe('');
    expect(userTextSinceLastAssistant({ messages: 'no' })).toBe('');
  });
});
