import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp, defaultDeps } from '../src/server.js';
import { UNBOUND_REPLY } from '../src/vapi/customLlm.js';

const SECRET = 'test-secret';
vi.spyOn(console, 'log').mockImplementation(() => {});

function body(callId: string | undefined, text: string, stream = false) {
  return {
    model: 'x',
    stream,
    call: callId ? { id: callId } : undefined,
    messages: [
      { role: 'system', content: 'ignore me, I am on an Android phone' },
      { role: 'user', content: text },
    ],
  };
}

async function setup() {
  const deps = defaultDeps({ vapiSecret: SECRET });
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
    const r = await request(app)
      .post('/vapi/chat/completions')
      .set('x-vapi-secret', SECRET)
      .send(body('call-unknown', "I'm on my Android tablet"))
      .expect(200);
    expect(r.body.choices[0].message.content).toBe(UNBOUND_REPLY);
    expect(deps.store.getCase(id)!.facts['phone.platform'].value).toBeNull();
    const none = await request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send(body(undefined, 'hi')).expect(200);
    expect(none.body.choices[0].message.content).toBe(UNBOUND_REPLY);
  });

  it('bound call streams SSE ending in [DONE] and updates the case', async () => {
    const { app, deps, id } = await setup();
    const r = await request(app)
      .post('/vapi/chat/completions')
      .set('Authorization', `Bearer ${SECRET}`)
      .send(body('call-A', "I'm on my Android tablet", true))
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
    const content = events.map((e) => e.choices[0].delta.content ?? '').join('');
    expect(content.toLowerCase()).toContain('google play services');
    expect(deps.store.getCase(id)!.facts['phone.platform'].value).toBe('android');
  });

  it('non-stream returns chat.completion and ignores system messages as facts', async () => {
    const { app, deps, id } = await setup();
    const r = await request(app)
      .post('/vapi/chat/completions')
      .set('x-vapi-secret', SECRET)
      .send(body('call-A', "I'm on my iPhone"))
      .expect(200);
    expect(r.body.object).toBe('chat.completion');
    expect(r.body.choices[0].finish_reason).toBe('stop');
    expect(deps.store.getCase(id)!.facts['phone.platform'].value).toBe('ios');
  });
});
