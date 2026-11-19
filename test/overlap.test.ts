import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp, defaultDeps } from '../src/server.js';
import { fakeRouter, fakeNamer } from './helpers/fakes.js';
import type { Responder } from '../src/reply/responder.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
const SECRET = 'test-secret';

/** Each reply speaks "Reply n." at once, then holds (like a long reply still streaming) until released. */
function holdingResponder() {
  let n = 0;
  const holdSecond = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const responder: Responder = {
    async *reply() {
      n += 1;
      yield `Reply ${n}. `;
      if (n === 1 || n === 2 && holdSecond) await gate;
      yield 'More.';
    },
  };
  return { responder, release, gate };
}

async function boot() {
  const h = holdingResponder();
  const deps = defaultDeps({ vapiSecret: SECRET, router: fakeRouter(), responder: h.responder, namer: fakeNamer(null) });
  const app = createApp(deps);
  const r = await request(app).post('/api/sessions');
  const auth = { Authorization: `Bearer ${r.body.token}` };
  await request(app).post(`/api/sessions/${r.body.sessionId}/bind`).set(auth).send({ callId: 'call-A' }).expect(200);
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/vapi/chat/completions`;
  const go = (text: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET },
      body: JSON.stringify({ call: { id: 'call-A' }, stream: true, messages: [{ role: 'system', content: 's' }, { role: 'assistant', content: 'Hi. What are you thinking about?' }, { role: 'user', content: text }] }),
    }).then((x) => x.text());
  const s = deps.sessions.get(r.body.sessionId)!;
  const users = () => s.turns.filter((t) => t.role === 'user').map((t) => t.text);
  return { s, go, users, release: h.release, close: () => server.close() };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a request that extends the text of a turn still running', () => {
  it('Vapi repeating the last word while the previous reply is streaming leaves one user turn', async () => {
    const { go, users, release, close } = await boot();
    try {
      const a = 'Hi. I am planning 10 days in Japan this March with 2 friends.';
      const reqs = [go(a)];
      await wait(80);
      reqs.push(go(`${a} Mostly Tokyo`));
      await wait(80);
      reqs.push(go(`${a} Mostly Tokyo, and Kyoto.`));
      await wait(80);
      reqs.push(go(`${a} Mostly Tokyo, and Kyoto. Kyoto.`));
      await wait(80);
      release();
      await Promise.all(reqs);
      expect(users()).toEqual([`${a} Mostly Tokyo, and Kyoto. Kyoto.`]);
    } finally {
      release();
      close();
    }
  });

  it('does not wait for the older reply to finish before running the newer turn', async () => {
    const { go, users, release, close } = await boot();
    try {
      const older = go('Oh, sorry.');
      await wait(80);
      const t0 = Date.now();
      const newer = go('Oh, sorry. Furano.');
      const text = await Promise.race([newer, wait(1500).then(() => 'TIMEOUT')]);
      expect(text).not.toBe("TIMEOUT"); // the gate is still closed: the older reply must have been aborted
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(users()).toEqual(['Oh, sorry. Furano.']);
      release();
      await older;
    } finally {
      release();
      close();
    }
  });
});

describe('a turn cut off after its filler was spoken', () => {
  it('leaves one user turn and no reply when a longer request replaces it', async () => {
    const h = holdingResponder();
    // The first reply says nothing until released, so only the 250 ms filler is written before the newer request.
    const slow: Responder = { async *reply() { if (!slowDone) { slowDone = true; await h.gate; } yield "Done."; } };
    let slowDone = false;
    const deps = defaultDeps({ vapiSecret: SECRET, router: fakeRouter(), responder: slow, namer: fakeNamer(null) });
    const app = createApp(deps);
    const r = await request(app).post('/api/sessions');
    await request(app).post(`/api/sessions/${r.body.sessionId}/bind`).set({ Authorization: `Bearer ${r.body.token}` }).send({ callId: 'call-A' }).expect(200);
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/vapi/chat/completions`;
    const go = (text: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET }, body: JSON.stringify({ call: { id: 'call-A' }, stream: true, messages: [{ role: 'system', content: 's' }, { role: 'assistant', content: 'Hi.' }, { role: 'user', content: text }] }) }).then((x) => x.text());
    try {
      const older = go('Tell me about Kyoto please');
      await wait(450);
      const newer = await go('Tell me about Kyoto please and Tokyo');
      const s = deps.sessions.get(r.body.sessionId)!;
      expect(s.turns.filter((t) => t.role === 'user').map((t) => t.text)).toEqual(['Tell me about Kyoto please and Tokyo']);
      expect(s.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
      expect(newer).toContain('data: [DONE]');
      await older;
    } finally {
      h.release();
      server.close();
    }
  });
});
