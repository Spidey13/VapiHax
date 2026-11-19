import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp, defaultDeps, type Deps } from '../src/server.js';
import { UNBOUND_REPLY, voiceChunk } from '../src/vapi/customLlm.js';
import { appendTurn } from '../src/tree/tree.js';
import { FILLERS } from '../src/reply/filler.js';
import { fakeRouter, fakeResponder, fakeNamer, gatedResponder, slowResponder } from './helpers/fakes.js';

const SECRET = 'test-secret';
vi.spyOn(console, 'log').mockImplementation(() => {});

function body(callId: string | undefined, text: string, stream = false) {
  return {
    model: 'x',
    stream,
    call: callId ? { id: callId } : undefined,
    messages: [
      { role: 'system', content: 'ignore me, fork everything' },
      { role: 'user', content: text },
    ],
  };
}

async function setup(overrides: Partial<Deps> = {}) {
  const deps = defaultDeps({
    vapiSecret: SECRET,
    router: fakeRouter(),
    responder: fakeResponder(['First sentence. ', 'Second one.']),
    namer: fakeNamer(null),
    ...overrides,
  });
  const app = createApp(deps);
  const r = await request(app).post('/api/sessions');
  const auth = { Authorization: `Bearer ${r.body.token}` };
  await request(app).post(`/api/sessions/${r.body.sessionId}/bind`).set(auth).send({ callId: 'call-A' }).expect(200);
  return { app, deps, id: r.body.sessionId as string };
}

describe('POST /vapi/chat/completions', () => {
  it('503 when secret unset; 401 on bad secret', async () => {
    const noSecret = createApp(defaultDeps({ vapiSecret: undefined }));
    await request(noSecret).post('/vapi/chat/completions').send(body('c', 'hi')).expect(503);
    const { app } = await setup();
    await request(app).post('/vapi/chat/completions').set('Authorization', 'Bearer wrong').send(body('call-A', 'hi')).expect(401);
    await request(app).post('/vapi/chat/completions').send(body('call-A', 'hi')).expect(401);
  });

  it('unbound call gets the safe message and touches no session', async () => {
    const { app, deps, id } = await setup();
    const r = await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body('call-unknown', 'hello')).expect(200);
    expect(r.body.choices[0].message.content).toBe(UNBOUND_REPLY);
    expect(deps.sessions.get(id)!.turns).toHaveLength(0);
    const none = await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body(undefined, 'hi')).expect(200);
    expect(none.body.choices[0].message.content).toBe(UNBOUND_REPLY);
  });

  it('bound call streams SSE ending in [DONE] with the responder text', async () => {
    const { app } = await setup();
    const r = await request(app)
      .post('/vapi/chat/completions')
      .set('Authorization', `Bearer ${SECRET}`)
      .send(body('call-A', 'a newsletter', true))
      .buffer(true)
      .parse((res, cb) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => cb(null, d));
      })
      .expect(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    const text = r.body as string;
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    const events = text.split('\n\n').filter((e) => e.startsWith('data: {')).map((e) => JSON.parse(e.slice(6)));
    expect(events[0].object).toBe('chat.completion.chunk');
    expect(events[0].choices[0].delta.role).toBe('assistant');
    expect(events.at(-1).choices[0].finish_reason).toBe('stop');
    expect(events.map((e) => e.choices[0].delta.content ?? '').join('')).toBe('First sentence. <flush />  Second one. <flush /> ');
  });

  it('streams the first sentence before the model finishes and stops on interrupt', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { app, deps, id } = await setup({ responder: gatedResponder(['First. '], gate, ['Second.']) });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/vapi/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET },
        body: JSON.stringify(body('call-A', 'hello', true)),
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let seen = '';
      while (!seen.includes('First.')) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += dec.decode(value);
      }
      expect(seen).toContain('First.'); // arrived while the responder is still blocked
      deps.responseEpoch.set(id, (deps.responseEpoch.get(id) ?? 0) + 1);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += dec.decode(value);
      }
      expect(seen.trim().endsWith('data: [DONE]')).toBe(true);
      expect(seen).not.toContain('Second.');
      release();
      expect(deps.sessions.get(id)!.turns.map((t) => [t.role, t.text])).toEqual([['user', 'hello'], ['assistant', 'First.']]);
    } finally {
      release();
      server.close();
    }
  });

  it('non-stream returns the reply, records the user turn and ignores the system message', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['Sure thing.']) });
    const r = await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body('call-A', 'a newsletter')).expect(200);
    expect(r.body.object).toBe('chat.completion');
    expect(r.body.choices[0].finish_reason).toBe('stop');
    expect(r.body.choices[0].message.content).toBe('Sure thing.');
    const s = deps.sessions.get(id)!;
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([['user', 'a newsletter'], ['assistant', 'Sure thing.']]);
    expect(Object.keys(s.branches)).toEqual(['b1']);
  });

  it('accepts a body over 32kb because Vapi resends the whole history', async () => {
    const { app } = await setup({ responder: fakeResponder(['Ok.']) });
    const b = body('call-A', 'latest');
    b.messages.unshift({ role: 'user', content: 'x'.repeat(40_000) }, { role: 'assistant', content: 'y'.repeat(40_000) });
    await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(b).expect(200);
  });

  it('caps the extracted user text at 1000 chars', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['Ok.']) });
    await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body('call-A', 'z'.repeat(5000))).expect(200);
    expect(deps.sessions.get(id)!.turns[0]!.text).toHaveLength(1000);
  });
});

describe('spoken-prefix trim and pre-lock abort', () => {
  const send = (app: ReturnType<typeof createApp>, messages: { role: string; content: string }[]) =>
    request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, messages }).expect(200);

  it('trims the recorded assistant turn to what Vapi says it spoke, without bumping the revision (speculation is keyed by it)', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['One two. ', 'Three four.']) });
    await send(app, [{ role: 'user', content: 'hello' }]);
    const s = deps.sessions.get(id)!;
    expect(s.turns[1]!.text).toBe('One two. Three four.');
    // Held so the request itself records nothing and the revision comparison is clean.
    s.hold = true;
    const rev = s.revision;
    await send(app, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'One  two.' }, { role: 'user', content: 'more' }]);
    expect(s.turns[1]!.text).toBe('One  two.');
    expect(s.revision).toBe(rev); // no bump: speculation is keyed by revision
    expect(s.turns).toHaveLength(2);
  });

  it('leaves the recorded turn alone for a full, non-prefix or empty assistant message', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['One two. ', 'Three four.']) });
    await send(app, [{ role: 'user', content: 'hello' }]);
    const s = deps.sessions.get(id)!;
    s.hold = true;
    for (const spoken of ['One two. Three four.', 'Something else', '  ']) {
      await send(app, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: spoken }, { role: 'user', content: 'x' }]);
      expect(s.turns[1]!.text).toBe('One two. Three four.');
    }
  });

  it('skips the turn entirely when the request is dropped before it gets the lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let calls = 0;
    const router = { async route() { calls++; return { op: { kind: 'fork' as const, acknowledge: false }, intent: null, by: 'jev' as const, ms: 1, reason: '' }; } };
    const { app, deps, id } = await setup({ router, responder: gatedResponder(['First. '], gate, ['Second.']) });
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/vapi/chat/completions`;
      const go = (text: string, signal?: AbortSignal) =>
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET }, body: JSON.stringify(body('call-A', text, true)), signal });
      const first = go('hello');
      await vi.waitFor(() => expect(calls).toBe(1));
      const ac = new AbortController();
      const second = go('so', ac.signal).catch(() => undefined); // queued behind the first
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await second;
      await new Promise((r) => setTimeout(r, 50));
      release();
      await (await first).text();
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toBe(1);
      expect(deps.sessions.get(id)!.turns.filter((t) => t.role === 'user').map((t) => t.text)).toEqual(['hello']);
      expect(Object.keys(deps.sessions.get(id)!.branches)).toHaveLength(2); // only the first request's fork
    } finally {
      release();
      server.close();
    }
  });
});

describe('speculation and stream failures', () => {
  it('routes once for two identical partials and a matching completion', async () => {
    let calls = 0;
    const router = { async route() { calls++; return { op: { kind: 'continue' as const }, intent: null, by: 'jev' as const, ms: 1, reason: '' }; } };
    const { app, deps, id } = await setup({ router });
    const post = (m: object) => request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send({ message: { call: { id: 'call-A' }, ...m } }).expect(200);
    await post({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'or a podcast' });
    await post({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'or a podcast' });
    await vi.waitFor(() => expect(deps.speculator!.runs).toBe(1));
    await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body('call-A', 'Or a podcast.')).expect(200);
    expect(calls).toBe(1);
    expect(deps.traces.list(id).some((t) => t.speculationHit === true)).toBe(true);
  });

  it('user partials reach the speculator before any assistant caption, final or playback event is sent', async () => {
    const { app, deps } = await setup();
    const seen: string[] = [];
    const spec = deps.speculator!;
    const orig = spec.onPartial.bind(spec);
    spec.onPartial = ((...a: any[]) => { seen.push('partial'); return (orig as any)(...a); }) as any;
    const post = (m: object) => request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send({ message: { call: { id: 'call-A' }, ...m } }).expect(200);
    await post({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'or a podcast' });
    await post({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'or a podcast' });
    expect(seen).toEqual(['partial', 'partial']); // both arrived before anything assistant-side was sent
    await post({ type: 'transcript', role: 'assistant', transcriptType: 'partial', transcript: 'Sure' });
    await post({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'Sure thing.' });
    await post({ type: 'assistant.speechStarted', text: 'Sure thing.', turn: 1, source: 'model' });
    expect(seen).toEqual(['partial', 'partial']); // assistant-side events never feed speculation
    await vi.waitFor(() => expect(deps.speculator!.runs).toBe(1));
  });

  it('does not apply a speculation made stale by a turn that held the lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let calls = 0;
    const router = { async route() { calls++; return { op: { kind: 'continue' as const }, intent: null, by: 'jev' as const, ms: 1, reason: '' }; } };
    const { app, deps, id } = await setup({ router, responder: gatedResponder(['First. '], gate, ['Second.']) });
    const post = (m: object) => request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send({ message: { call: { id: 'call-A' }, ...m } }).expect(200);
    await post({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'or a podcast' });
    await post({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'or a podcast' });
    await vi.waitFor(() => expect(deps.speculator!.runs).toBe(1));
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/vapi/chat/completions`;
      const go = (text: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET }, body: JSON.stringify(body('call-A', text, false)) });
      const first = go('hello'); // holds the session lock on the gated responder
      await vi.waitFor(() => expect(calls).toBe(2));
      const second = go('or a podcast'); // queued behind the first
      await new Promise((r) => setTimeout(r, 50));
      release();
      await Promise.all([first, second]);
      expect(calls).toBe(3); // the stale speculation was not used
      expect(deps.traces.list(id).some((t) => t.speculationHit === true)).toBe(false);
    } finally {
      release();
      server.close();
    }
  });

  it('ends the SSE with [DONE] when the router throws on the stream path', async () => {
    const router = { async route(): Promise<never> { throw new Error('boom'); } };
    const { app } = await setup({ router });
    const r = await request(app)
      .post('/vapi/chat/completions')
      .set('x-vapi-secret', SECRET)
      .send(body('call-A', 'hello', true))
      .buffer(true)
      .parse((res, cb) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => cb(null, d));
      })
      .expect(200);
    expect((r.body as string).trim().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('POST /vapi/events', () => {
  const ev = (message: object) => ({ message: { call: { id: 'call-A' }, ...message } });

  it('rejects bad secrets', async () => {
    const { app } = await setup();
    await request(app).post('/vapi/events').send(ev({ type: 'user-interrupted' })).expect(401);
  });

  it('bumps the interrupt epoch on interruption and user speech start', async () => {
    const { app, deps, id } = await setup();
    const post = (m: object) => request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send(ev(m)).expect(200);
    await post({ type: 'user-interrupted' });
    expect(deps.responseEpoch.get(id)).toBe(1);
    await post({ type: 'speech-update', role: 'user', status: 'started' });
    expect(deps.responseEpoch.get(id)).toBe(2);
    await post({ type: 'speech-update', role: 'assistant', status: 'started' });
    expect(deps.responseEpoch.get(id)).toBe(2);
  });

  it('once a reply has written a sentence, user speech start is ignored but user-interrupted still cuts', async () => {
    const { app, deps, id } = await setup();
    const post = (m: object) => request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send(ev(m)).expect(200);
    deps.replyWriting.add(id);
    await post({ type: 'speech-update', role: 'user', status: 'started' });
    expect(deps.responseEpoch.get(id) ?? 0).toBe(0);
    await post({ type: 'user-interrupted' });
    expect(deps.responseEpoch.get(id)).toBe(1);
  });

  it('marks the reply as writing while streaming and clears it when the reply ends', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { app, deps, id } = await setup({ responder: gatedResponder(['First. '], gate, ['Second.']) });
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/vapi/chat/completions`;
      const p = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET }, body: JSON.stringify(body('call-A', 'hello', true)) });
      await vi.waitFor(() => expect(deps.replyWriting.has(id)).toBe(true));
      release();
      await (await p).text();
      expect(deps.replyWriting.has(id)).toBe(false);
    } finally {
      release();
      server.close();
    }
  });

  describe('stale-guard rebuild after a tap-switch', () => {
    /** Calls listed in `slowCalls` (1-based) hang until aborted; others answer "Rebuilt." */
    function scripted(slowCalls: number[]) {
      const st = { calls: 0 };
      const responder: Deps['responder'] = {
        async *reply(_i, signal) {
          const n = ++st.calls;
          if (slowCalls.includes(n)) {
            await new Promise<void>((_, rej) => {
              if (signal?.aborted) return rej(new Error('aborted'));
              signal?.addEventListener('abort', () => rej(new Error('aborted')));
            });
          }
          yield 'Rebuilt.';
        },
      };
      return { st, responder };
    }

    async function run(slowCalls: number[], interrupt: (ctx: { app: Awaited<ReturnType<typeof setup>>['app']; deps: Deps; id: string; auth: Record<string, string>; st: { calls: number } }) => Promise<void>, expectCalls: number) {
      const sc = scripted(slowCalls.map((n) => n + 2)); // the two setup turns use calls 1-2
      const { app, deps, id } = await setup({ router: fakeRouter({ kind: 'continue' }, { kind: 'fork', acknowledge: false }), responder: sc.responder });
      const token = deps.tokens.get(id)!;
      const auth = { Authorization: `Bearer ${token}` };
      await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body('call-A', 'one')).expect(200);
      await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ ...body('call-A', 'two'), messages: [{ role: 'assistant', content: 'Rebuilt.' }, { role: 'user', content: 'two' }] }).expect(200);
      const s = deps.sessions.get(id)!;
      const [b1, b2] = Object.keys(s.branches);
      expect(s.currentBranchId).toBe(b2);
      const server = app.listen(0);
      try {
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/vapi/chat/completions`;
        const p = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET }, body: JSON.stringify({ ...body('call-A', 'hello', true), messages: [{ role: 'assistant', content: 'Rebuilt.' }, { role: 'user', content: 'hello' }] }) });
        await vi.waitFor(() => expect(sc.st.calls).toBe(3));
        await interrupt({ app, deps, id, auth, st: sc.st });
        const text = await (await p).text();
        expect(text.trim().endsWith('data: [DONE]')).toBe(true);
        expect(sc.st.calls).toBe(expectCalls);
        expect(deps.switchedDuring.has(id)).toBe(false);
        return { text, s, b1: b1!, b2: b2! };
      } finally {
        server.close();
      }
    }

    it('re-runs the turn once on the branch the user switched to', async () => {
      const ctx = { b1: '' };
      const out = await run(
        [1],
        async ({ app, id, auth, st }) => {
          void st;
          const first = ((await request(app).get(`/api/sessions/${id}`).set(auth)).body.branches as { id: string }[])[0]!.id;
          ctx.b1 = first;
          await request(app).post(`/api/sessions/${id}/switch`).set(auth).send({ branchId: first }).expect(200);
        },
        4,
      );
      expect(out.text).toContain('Rebuilt.');
      const turns = out.s.turns.filter((t) => t.text === 'hello');
      expect(turns).toHaveLength(1);
      expect(turns[0]!.branchId).toBe(ctx.b1);
      expect(out.s.turns.at(-1)!.role).toBe('assistant');
      expect(out.s.turns.at(-1)!.branchId).toBe(ctx.b1);
      expect(out.s.currentBranchId).toBe(ctx.b1);
    });

    it('does not rebuild when the abort was user speech', async () => {
      const out = await run([1], async ({ deps, id }) => void deps.responseEpoch.set(id, (deps.responseEpoch.get(id) ?? 0) + 1), 3);
      expect(out.s.turns.filter((t) => t.text === 'hello')).toHaveLength(0);
    });

    it('speech first, tap-switch after: no rebuild', async () => {
      const out = await run(
        [1],
        async ({ app, deps, id, auth }) => {
          deps.responseEpoch.set(id, (deps.responseEpoch.get(id) ?? 0) + 1);
          deps.switchedDuring.delete(id);
          await new Promise((r) => setTimeout(r, 250)); // the aborted reply has finished by now
          const first = ((await request(app).get(`/api/sessions/${id}`).set(auth)).body.branches as { id: string }[])[0]!.id;
          await request(app).post(`/api/sessions/${id}/switch`).set(auth).send({ branchId: first }).expect(200);
          deps.switchedDuring.delete(id); // a late idle switch leaves its marker; the next request clears it
        },
        3,
      );
      expect(out.s.turns.filter((t) => t.text === 'hello')).toHaveLength(0);
    });

    it('a second move during the rebuild aborts it without a further rebuild', async () => {
      const out = await run(
        [1, 2],
        async ({ app, id, auth, st }) => {
          const b = (await request(app).get(`/api/sessions/${id}`).set(auth)).body.branches as { id: string }[];
          await request(app).post(`/api/sessions/${id}/switch`).set(auth).send({ branchId: b[0]!.id }).expect(200);
          await vi.waitFor(() => expect(st.calls).toBe(4));
          await request(app).post(`/api/sessions/${id}/switch`).set(auth).send({ branchId: b[1]!.id }).expect(200);
        },
        4,
      );
      expect(out.s.turns.filter((t) => t.text === 'hello')).toHaveLength(0);
    });
  });

  it('stamps partial and final transcript times on the trace', async () => {
    const { app, deps, id } = await setup();
    const post = (m: object) => request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send(ev(m)).expect(200);
    await post({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'a news' });
    await post({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: 'a newsletter' });
    const [t] = deps.traces.list(id);
    expect(t!.firstPartialAt).toBeTypeOf('number');
    expect(t!.finalAt).toBeTypeOf('number');
  });
});

describe('early decision publish and filler-aware trim', () => {
  const rec = { op: { kind: 'recap' as const }, intent: null, by: 'jev' as const, ms: 1, reason: '' };
  const cont = { op: { kind: 'continue' as const }, intent: null, by: 'jev' as const, ms: 1, reason: '' };

  it('publishes lastDecision before the reply finishes (streaming)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const router = { async route() { return rec; } };
    const { app, deps, id } = await setup({ router, responder: gatedResponder(['Recap. '], gate, ['More.']) });
    appendTurn(deps.sessions.get(id)!, deps.sessions.get(id)!.currentBranchId, 'user', 'earlier', Date.now()); // else recap is canned
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const p = fetch(`http://127.0.0.1:${port}/vapi/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET },
        body: JSON.stringify(body('call-A', 'where was I', true)),
      });
      await vi.waitFor(() => expect(deps.lastDecisions.get(id)?.op.kind).toBe('recap'));
      release();
      await (await p).text();
    } finally {
      release();
      server.close();
    }
  });

  it('does not publish (and restores the previous) decision when the turn is rolled back', async () => {
    const router = { async route() { return rec; } };
    const { app, deps, id } = await setup({ router, responder: slowResponder() });
    deps.lastDecisions.set(id, cont);
    appendTurn(deps.sessions.get(id)!, deps.sessions.get(id)!.currentBranchId, 'user', 'earlier', Date.now());
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const p = fetch(`http://127.0.0.1:${port}/vapi/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET },
        body: JSON.stringify(body('call-A', 'where was I', true)),
      });
      await vi.waitFor(() => expect(deps.lastDecisions.get(id)?.op.kind).toBe('recap'));
      deps.responseEpoch.set(id, (deps.responseEpoch.get(id) ?? 0) + 1); // user interrupts before anything is spoken
      await (await p).text();
      expect(deps.lastDecisions.get(id)?.op.kind).toBe('continue');
      expect(deps.sessions.get(id)!.turns).toHaveLength(1); // only the seeded turn
    } finally {
      server.close();
    }
  });

  it('trims an interrupted reply that Vapi reports as "filler + partial"', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['One two. ', 'Three four.']) });
    const send = (messages: { role: string; content: string }[]) =>
      request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, messages }).expect(200);
    await send([{ role: 'user', content: 'hello' }]);
    const s = deps.sessions.get(id)!;
    s.hold = true;
    await send([{ role: 'user', content: 'hello' }, { role: 'assistant', content: `${FILLERS[0]} One two.` }, { role: 'user', content: 'x' }]);
    expect(s.turns[1]!.text).toBe('One two.');
  });

  it('keeps a reply that itself starts with a filler word when it is a plain prefix', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['Okay. ', 'Then more here.']) });
    const send = (messages: { role: string; content: string }[]) =>
      request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, messages }).expect(200);
    await send([{ role: 'user', content: 'hello' }]);
    const s = deps.sessions.get(id)!;
    s.hold = true;
    await send([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Okay.' }, { role: 'user', content: 'x' }]);
    expect(s.turns[1]!.text).toBe('Okay.'); // raw prefix wins; stripping would leave nothing
  });

  it('a command placed before a filler-prefixed cut assistant message reaches the router whole', async () => {
    const utterances: string[] = [];
    const router = { async route(i: { utterance: string }) { utterances.push(i.utterance); return { op: { kind: 'continue' as const }, intent: null, by: 'fallback' as const, ms: 0, reason: '' }; } };
    const { app } = await setup({ router, responder: fakeResponder(['Winter is lovely here. ', 'Sights or a slower pace?']) });
    const send = (messages: { role: string; content: string }[]) =>
      request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, messages }).expect(200);
    await send([{ role: 'user', content: 'Plan a winter trip' }]);
    await send([{ role: 'user', content: 'Plan a winter trip' }, { role: 'user', content: 'Switch back to Tokyo' }, { role: 'assistant', content: `${FILLERS[0]} Winter is lovely here.` }]);
    expect(utterances.at(-1)).toBe('Switch back to Tokyo');
  });

  it('matches the filler case-insensitively and only at a word boundary', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['One two. ', 'Three four.']) });
    const send = (messages: { role: string; content: string }[]) =>
      request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, messages }).expect(200);
    await send([{ role: 'user', content: 'hello' }]);
    const s = deps.sessions.get(id)!;
    s.hold = true;
    await send([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'okay, let me see. One two.' }, { role: 'user', content: 'x' }]);
    expect(s.turns[1]!.text).toBe('One two.');
    s.turns[1]!.text = 'Okayish one. Two.';
    await send([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Okayish one.' }, { role: 'user', content: 'x' }]);
    expect(s.turns[1]!.text).toBe('Okayish one.');
  });

  it('keeps a reply untouched when Vapi spoke it with different formatting, and does not bump the revision', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['Three people, ', 'in Kyoto.']) });
    const send = (messages: { role: string; content: string }[]) =>
      request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, messages }).expect(200);
    await send([{ role: 'user', content: 'hello' }]);
    const s = deps.sessions.get(id)!;
    s.hold = true;
    const rev = s.revision;
    await send([{ role: 'user', content: 'hello' }, { role: 'assistant', content: '3 people. In Kyoto.' }, { role: 'user', content: 'x' }]);
    expect(s.turns[1]!.text).toBe('Three people, in Kyoto.');
    expect(s.revision).toBe(rev);
  });

  it('trims to the generated words when Vapi spoke a formatted prefix, without bumping the revision', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['Three people, ', 'in Kyoto. ', 'Then Osaka.']) });
    const send = (messages: { role: string; content: string }[]) =>
      request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, messages }).expect(200);
    await send([{ role: 'user', content: 'hello' }]);
    const s = deps.sessions.get(id)!;
    s.hold = true;
    const rev = s.revision;
    await send([{ role: 'user', content: 'hello' }, { role: 'assistant', content: '3 people. In Kyoto.' }, { role: 'user', content: 'x' }]);
    expect(s.turns[1]!.text).toBe('Three people, in Kyoto'); // up to the last spoken word
    expect(s.revision).toBe(rev);
  });

  it('strips a filler and then matches the formatted remainder', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['Three people, ', 'in Kyoto. ', 'Then Osaka.']) });
    const send = (messages: { role: string; content: string }[]) =>
      request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, messages }).expect(200);
    await send([{ role: 'user', content: 'hello' }]);
    const s = deps.sessions.get(id)!;
    s.hold = true;
    await send([{ role: 'user', content: 'hello' }, { role: 'assistant', content: `${FILLERS[0]} 3 people. In Kyoto.` }, { role: 'user', content: 'x' }]);
    expect(s.turns[1]!.text).toBe('Three people, in Kyoto');
  });

  it('leaves the reply alone when the spoken text is a different place', async () => {
    const { app, deps, id } = await setup({ responder: fakeResponder(['Stay in Furano.']) });
    const send = (messages: { role: string; content: string }[]) =>
      request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, messages }).expect(200);
    await send([{ role: 'user', content: 'hello' }]);
    const s = deps.sessions.get(id)!;
    s.hold = true;
    await send([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Stay in Niseko.' }, { role: 'user', content: 'x' }]);
    expect(s.turns[1]!.text).toBe('Stay in Furano.');
  });
});

describe('transport framing: flush tags (not evidence of early audio)', () => {
  const readFrames = async (port: number, text: string, until: (seen: string) => boolean) => {
    const res = await fetch(`http://127.0.0.1:${port}/vapi/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET },
      body: JSON.stringify(body('call-A', text, true)),
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!until(seen)) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    return { reader, dec, seen };
  };
  const drainRest = async (r: { reader: ReadableStreamDefaultReader<Uint8Array>; dec: TextDecoder; seen: string }) => {
    let all = r.seen;
    for (;;) {
      const { value, done } = await r.reader.read();
      if (done) break;
      all += r.dec.decode(value);
    }
    return all;
  };
  const contents = (sse: string) =>
    sse.split('\n\n').filter((e) => e.startsWith('data: {')).map((e) => JSON.parse(e.slice(6)).choices[0].delta.content ?? '').join('');
  const collect = (res: any, cb: (e: Error | null, b: string) => void) => {
    let d = '';
    res.on('data', (c: Buffer) => (d += c));
    res.on('end', () => cb(null, d));
  };

  it('voiceChunk trims trailing whitespace and appends one flush tag', () => {
    expect(voiceChunk('Got it. ')).toBe('Got it. <flush /> ');
    expect(voiceChunk('Got it.')).toBe('Got it. <flush /> ');
    expect(voiceChunk('Got it.  \n')).toBe('Got it. <flush /> ');
  });

  it('the first SSE frame carries the sentence and a flush tag while the responder is still blocked; nothing stored has a tag', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { app, deps, id } = await setup({ responder: gatedResponder(['Sure thing. '], gate, ['Then more.']) });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const r = await readFrames(port, 'hello', (x) => x.includes('<flush />'));
      expect(contents(r.seen)).toBe('Sure thing. <flush /> ');
      release();
      const all = await drainRest(r);
      expect(contents(all)).toBe('Sure thing. <flush />  Then more. <flush /> ');
      expect((contents(all).match(/<flush \/>/g) ?? []).length).toBe(2); // once per complete sentence
      const turns = deps.sessions.get(id)!.turns;
      expect(turns.map((t) => t.text)).toEqual(['hello', 'Sure thing. Then more.']);
      expect(JSON.stringify(turns)).not.toContain('flush');
    } finally {
      release();
      server.close();
    }
  });

  it('a filler is framed with a flush tag, not a trailing space, and is never stored', async () => {
    const slow: any = { async *reply() { await new Promise((r) => setTimeout(r, 400)); yield 'Real answer.'; } };
    const { app, deps, id } = await setup({ responder: slow });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const r = await readFrames(port, 'hello', (x) => x.includes('Real answer.'));
      const text = contents(await drainRest(r));
      const first = FILLERS.find((f) => text.startsWith(`${f} <flush />`));
      expect(first).toBeDefined();
      expect(text).toBe(`${first} <flush />  Real answer. <flush /> `);
      expect(deps.sessions.get(id)!.turns.map((t) => t.text)).toEqual(['hello', 'Real answer.']);
    } finally {
      server.close();
    }
  });

  it('the silent path and non-stream JSON carry no flush tag', async () => {
    const { app, deps, id } = await setup();
    deps.sessions.get(id)!.hold = true;
    const silent = await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body('call-A', 'hello', true)).buffer(true).parse(collect);
    expect(contents(silent.body as string)).toBe('');
    expect(silent.body as string).not.toContain('flush');
    deps.sessions.get(id)!.hold = false;
    const json = await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body('call-A', 'hello', false)).expect(200);
    expect(json.body.choices[0].message.content).toBe('First sentence. Second one.');
  });

  it('flush tags Vapi echoes back never reach reconciliation or user text', async () => {
    const { contentText } = await import('../src/vapi/reconcile.js');
    expect(contentText('Sure thing. <flush /> ')).not.toMatch(/flush/i);
    expect(contentText('a<flush>b</flush>c <FLUSH/> d < flush / > e').replace(/\s+/g, ' ')).toBe('abc d e');
    expect(contentText([{ text: 'x <flush />' }, { text: 'y' }])).not.toMatch(/flush/i);
    const { userTextSinceLastAssistant } = await import('../src/vapi/customLlm.js');
    expect(userTextSinceLastAssistant({ messages: [{ role: 'assistant', content: 'Hi. <flush /> ' }, { role: 'user', content: 'ok <flush />' }] })).toBe('ok');
  });
});

describe('playback evidence from assistant.speechStarted', () => {
  it('stamps playbackStartedAt once per new turn on the latest emitted trace and logs one line without text', async () => {
    const { app, deps, id } = await setup();
    await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body('call-A', 'hello', true)).buffer(true).parse((res: any, cb: any) => { let d = ''; res.on('data', (c: Buffer) => (d += c)); res.on('end', () => cb(null, d)); });
    const trace = deps.traces.list(id).at(-1)!;
    expect(trace.firstChunkAt).toBeDefined();
    expect(trace.playbackStartedAt).toBeUndefined();
    const log = console.log as unknown as ReturnType<typeof vi.fn>;
    log.mockClear();
    const post = (m: object) => request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send({ message: { call: { id: 'call-A' }, ...m } }).expect(200);
    await post({ type: 'assistant.speechStarted', text: 'First sentence.', turn: 3, source: 'model' });
    await vi.waitFor(() => expect(trace.playbackStartedAt).toBeDefined());
    const first = trace.playbackStartedAt;
    await post({ type: 'assistant.speechStarted', text: 'First sentence. Second one.', turn: 3, source: 'model' }); // same turn, next chunk
    expect(trace.playbackStartedAt).toBe(first);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"event":"playback"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ sessionId: id, event: 'playback', turn: 3, source: 'model' });
    expect(lines[0]).not.toContain('First sentence');
  });
  it('attributes playback to the request that emitted, not to a later one that emitted nothing', async () => {
    const { app, deps, id } = await setup();
    await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body('call-A', 'hello', true)).buffer(true).parse((res: any, cb: any) => { let d = ''; res.on('data', (c: Buffer) => (d += c)); res.on('end', () => cb(null, d)); });
    const [first] = deps.traces.list(id).filter((t) => t.firstEmitAt !== undefined).slice(-1);
    expect(first).toBeDefined();
    const silent = deps.traces.current(id, 'final');
    expect(silent.firstEmitAt).toBeUndefined();
    await request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send({ message: { call: { id: 'call-A' }, type: 'assistant.speechStarted', text: 'Hi.', turn: 9, source: 'model' } }).expect(200);
    await vi.waitFor(() => expect(first!.playbackStartedAt).toBeDefined());
    expect(silent.playbackStartedAt).toBeUndefined();
  });
});
