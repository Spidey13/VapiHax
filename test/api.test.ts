import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, defaultDeps, type Deps } from '../src/server.js';
import { fakeRouter, fakeResponder, fakeNamer } from './helpers/fakes.js';

async function start(overrides: Partial<Deps> = {}) {
  const app = createApp(
    defaultDeps({ vapiSecret: 's', router: fakeRouter(), responder: fakeResponder(['Okay.']), namer: fakeNamer(null), ...overrides }),
  );
  const r = await request(app).post('/api/sessions').expect(201);
  const auth = { Authorization: `Bearer ${r.body.token}` };
  return { app, id: r.body.sessionId as string, auth, created: r.body };
}

describe('http api', () => {
  it('config exposes the endpointing wait', async () => {
    const { app } = await start({ publicConfig: { vapiPublicKey: 'k', assistantId: 'a' } });
    const r = await request(app).get('/api/config').expect(200);
    expect(r.body).toEqual({ vapiPublicKey: 'k', assistantId: 'a', endpointing: { waitMs: 1900 } });
  });

  it('rejects a wrong token with 401 and an unknown session with 404', async () => {
    const { app, id, created } = await start();
    expect(created.state.currentBranchId).toBe('b1');
    await request(app).get(`/api/sessions/${id}`).set('Authorization', 'Bearer nope').expect(401);
    await request(app).get(`/api/sessions/${id}`).expect(401);
    await request(app).get('/api/sessions/does-not-exist').set('Authorization', 'Bearer x').expect(404);
  });

  it('a typed turn can fork, and switching back shows the main path', async () => {
    const { app, id, auth } = await start({
      router: fakeRouter({ kind: 'continue' }, { kind: 'fork', acknowledge: false }),
      responder: fakeResponder(['Okay.']),
    });
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'a newsletter' }).expect(200);
    const r = await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'or a podcast?' }).expect(200);
    expect(r.body.state.currentBranchId).toBe('b2');
    expect(r.body.decision.op.kind).toBe('fork');
    const sw = await request(app).post(`/api/sessions/${id}/switch`).set(auth).send({ branchId: 'b1' }).expect(200);
    expect(sw.body.state.path.map((t: { text: string }) => t.text)).toEqual(['a newsletter', 'Okay.']);
    const got = await request(app).get(`/api/sessions/${id}`).set(auth).expect(200);
    expect(got.body.lastDecision.op.kind).toBe('fork');
    const tr = await request(app).get(`/api/sessions/${id}/trace`).set(auth).expect(200);
    expect(tr.body.traces).toHaveLength(2);
  });

  it('empty text is 400; text over 1000 characters is truncated', async () => {
    const { app, id, auth } = await start({});
    await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: '   ' }).expect(400);
    const r = await request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text: 'x'.repeat(1500) }).expect(200);
    expect(r.body.state.path[0].text).toHaveLength(1000);
  });

  it('switch to an unknown branch is 400; to the current branch is a no-op', async () => {
    const { app, id, auth } = await start({});
    await request(app).post(`/api/sessions/${id}/switch`).set(auth).send({ branchId: 'b99' }).expect(400);
    const before = (await request(app).get(`/api/sessions/${id}`).set(auth)).body.revision;
    const r = await request(app).post(`/api/sessions/${id}/switch`).set(auth).send({ branchId: 'b1' }).expect(200);
    expect(r.body.state.revision).toBe(before);
  });

  it('inherited keys are not branch ids', async () => {
    const { app, id, auth } = await start({});
    for (const branchId of ['constructor', '__proto__', 'toString']) {
      await request(app).post(`/api/sessions/${id}/switch`).set(auth).send({ branchId }).expect(400);
    }
    const r = await request(app).get(`/api/sessions/${id}`).set(auth).expect(200);
    expect(r.body.currentBranchId).toBe('b1');
  });

  it('bind conflicts with 409', async () => {
    const { app, id, auth } = await start();
    await request(app).post(`/api/sessions/${id}/bind`).set(auth).send({ callId: 'call-1' }).expect(200);
    await request(app).post(`/api/sessions/${id}/bind`).set(auth).send({}).expect(400);
    const other = await request(app).post('/api/sessions').expect(201);
    await request(app)
      .post(`/api/sessions/${other.body.sessionId}/bind`)
      .set({ Authorization: `Bearer ${other.body.token}` })
      .send({ callId: 'call-1' })
      .expect(409);
  });

  it('a tap-switch bumps the response epoch for that session', async () => {
    const responseEpoch = new Map<string, number>();
    const { app, id, auth } = await start({ responseEpoch });
    const before = responseEpoch.get(id) ?? 0;
    await request(app).post(`/api/sessions/${id}/switch`).set(auth).send({ branchId: 'b1' }).expect(200);
    expect(responseEpoch.get(id)).toBeGreaterThan(before);
  });
});
