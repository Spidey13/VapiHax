import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, defaultDeps } from '../src/server.js';

async function start() {
  const app = createApp(defaultDeps({ vapiSecret: 's3cret' }));
  const r = await request(app).post('/api/sessions').expect(201);
  const auth = { Authorization: `Bearer ${r.body.token}` };
  return { app, id: r.body.sessionId as string, auth };
}

describe('http api', () => {
  it('rejects wrong token with 401 and unknown session with 404', async () => {
    const { app, id } = await start();
    await request(app).get(`/api/sessions/${id}`).set('Authorization', 'Bearer nope').expect(401);
    await request(app).get(`/api/sessions/${id}`).expect(401);
    await request(app).get('/api/sessions/does-not-exist').set('Authorization', 'Bearer x').expect(404);
  });

  it('runs journey 2 over http', async () => {
    const { app, id, auth } = await start();
    const t = (text: string) => request(app).post(`/api/sessions/${id}/turn`).set(auth).send({ text });
    let r = await t("my Eve Energy won't pair, I'm on my iPhone").expect(200);
    expect(r.body.state.currentCheck.id).toBe('ios-credential-sync');
    r = await t("Actually I'm using my Android tablet").expect(200);
    expect(r.body.reply.toLowerCase()).toContain('google play services');
    expect(r.body.state.notices.some((n: { kind: string }) => n.kind === 'superseded')).toBe(true);
    r = await t('yes, Google services').expect(200);
    expect(r.body.state.currentCheck.id).toBe('android-credential-sync');
    const md = await request(app).get(`/api/sessions/${id}/packet.md`).set(auth).expect(200);
    expect(md.headers['content-disposition']).toContain('attachment');
    expect(md.text).toContain('EXAMPLE CASE');
    await request(app).get(`/api/sessions/${id}/packet.json`).set(auth).expect(200);
  });

  it('typed fact edit, reset and bind', async () => {
    const { app, id, auth } = await start();
    let r = await request(app).patch(`/api/sessions/${id}/facts`).set(auth).send({ path: 'phone.platform', value: 'ios' }).expect(200);
    expect(r.body.state.facts['phone.platform'].origin).toBe('typed');
    expect(r.body.state.currentCheck.id).toBe('ios-credential-sync');
    await request(app).patch(`/api/sessions/${id}/facts`).set(auth).send({ path: 'bogus', value: 'x' }).expect(400);
    await request(app).post(`/api/sessions/${id}/bind`).set(auth).send({ callId: 'call-1' }).expect(200);
    const other = await request(app).post('/api/sessions').expect(201);
    await request(app)
      .post(`/api/sessions/${other.body.sessionId}/bind`)
      .set({ Authorization: `Bearer ${other.body.token}` })
      .send({ callId: 'call-1' })
      .expect(409);
    r = await request(app).post(`/api/sessions/${id}/reset`).set(auth).expect(200);
    expect(r.body.state.epoch).toBe(2);
    expect(r.body.state.facts['phone.platform'].value).toBeNull();
  });
});
