/**
 * npm run film:standin
 * Builds stand-in film data with the dinner/barbecue prompts. The states come from the
 * real server code (typed turns through createApp, with scripted routing, replies and names), so their shape is
 * exactly what the client logs; the timings and the replies are invented, and the file says so ("standIn": true).
 * Writes film/data/session.json and film/data/captions.json (Remotion Caption format). No network, no keys.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp, defaultDeps } from '../src/server.js';
import type { Op, RouteDecision, Router } from '../src/route/types.js';
import type { Responder } from '../src/reply/responder.js';

const GREETING = 'Hi. What are you thinking about?';
interface Line { say: string; reply: string; op: (ids: Record<string, string>) => Op }
const LINES: Line[] = [
  {
    say: "I'm planning my dad's sixtieth birthday, about twenty people, and I'm thinking a nice restaurant dinner.",
    reply: 'Twenty is a good size for a private room. Do you have a place in mind yet?',
    op: () => ({ kind: 'continue' }),
  },
  {
    say: 'Actually, what if we skipped the restaurant and did a backyard barbecue instead?',
    reply: "A barbecue feels more like him. Who's on the grill, and is there a rain plan?",
    op: () => ({ kind: 'fork', acknowledge: false }),
  },
  {
    say: 'Saturday afternoon, with a big grill and a few long tables under string lights.',
    reply: 'That sounds easy to love. Who takes the grill, so you get to sit with him?',
    op: () => ({ kind: 'continue' }),
  },
  {
    say: 'Go back to the fancy one, where everyone gets waited on.',
    reply: "Back to the dinner. You were weighing a private room for twenty. Is there a place he's always liked?",
    op: (ids) => ({ kind: 'switch', targetId: ids.dinner }),
  },
  {
    say: "What's the difference between the two?",
    reply: 'The dinner is formal and someone else does the work. The barbecue is relaxed, but you host and cook.',
    op: (ids) => ({ kind: 'compare', otherId: ids.bbq }),
  },
  {
    say: 'Okay, combine them into one plan.',
    reply: 'One plan: a catered barbecue in the backyard, with a short sit-down toast so it still feels like an occasion.',
    op: (ids) => ({ kind: 'merge', otherId: ids.bbq }),
  },
];
// The root branch keeps the server's own name ("Main"); forks and merges are named by the namer.
const NAMES = ['Backyard barbecue', 'Catered backyard party'];

const ids: Record<string, string> = {};
let turn = 0;
const router: Router = {
  async route(): Promise<RouteDecision> {
    return { op: LINES[turn].op(ids), intent: null, by: 'jev', ms: 1, reason: 'stand-in' };
  },
};
const responder: Responder = { async *reply() { yield LINES[turn].reply; } };
let named = 0;
const app = createApp(defaultDeps({
  router,
  responder,
  namer: { async name() { return NAMES[Math.min(named++, NAMES.length - 1)]; } },
  digester: { async digest(name) { return `${name}: stand-in digest.`; } },
  summarizer: {
    async summarize(s) {
      const bs = Object.values(s.branches);
      const line: Record<string, string> = {
        [ids.dinner]: 'A private room for twenty; the venue is still open.',
        [ids.bbq]: 'Saturday afternoon at home, with a grill and long tables.',
      };
      return {
        covered: "Planning your dad's sixtieth for about twenty people. You compared a restaurant dinner with a backyard barbecue and combined them into a catered barbecue with a sit-down toast.",
        branches: bs.filter((b) => b.status !== 'provisional').map((b) => ({ id: b.id, line: line[b.id] ?? 'A catered barbecue at home with a short sit-down toast.' })),
        open: ['Which caterer, and what it costs for twenty.', 'A rain plan for the backyard.'],
      };
    },
  },
  vapiSecret: 's',
}));

// ---- timing model (invented): words at 2.6 a second, a 1.4 s wait before each reply, 1.6 s before the next line ----
const WPS = 2.6;
const GAP = 1.4;
const words: { text: string; start: number; end: number }[] = [];
const events: any[] = [];
const ev = (t: number, e: object) => events.push({ t: Math.round(t * 1000) / 1000, ...e });
function speak(role: 'user' | 'assistant', text: string, start: number): number {
  const ws = text.split(/\s+/);
  const dur = ws.length / WPS;
  ev(start, { type: 'speech', role, status: 'started' });
  ws.forEach((w, i) => {
    const a = start + (i / ws.length) * dur;
    words.push({ text: w, start: Math.round(a * 1000) / 1000, end: Math.round((a + dur / ws.length - 0.03) * 1000) / 1000 });
    // Live captions for the user only: the reply reaches the screen through the server's state.
    if (role === 'user' && (i % 2 === 1 || i === ws.length - 1)) ev(a + 0.25, { type: 'transcript', role, final: false, text: ws.slice(0, i + 1).join(' ') });
  });
  ev(start + dur, { type: 'speech', role, status: 'stopped' });
  ev(start + dur + 0.3, { type: 'transcript', role, final: true, text });
  return start + dur;
}
/** The state before the reply is recorded: the reply's turn is not in it yet. */
function withoutReply(state: any) {
  const s = JSON.parse(JSON.stringify(state));
  s.revision -= 1;
  const drop = (p: any[]) => (p.length && p[p.length - 1].role === 'assistant' ? p.slice(0, -1) : p);
  s.path = drop(s.path);
  s.sheets.current.path = drop(s.sheets.current.path);
  return s;
}

const r0 = await request(app).post('/api/sessions').expect(201);
const sid = r0.body.sessionId as string;
const auth = { Authorization: `Bearer ${r0.body.token}` };
ids.dinner = r0.body.state.currentBranchId;
ev(0, { type: 'state', state: r0.body.state });
let t = speak('assistant', GREETING, 0.8) + 2.2;

const KIND: Record<string, string> = { fork: 'fork', switch: 'switch', compare: 'compare', merge: 'merge' };
const ANIM: Record<string, number> = { fork: 1.2, switch: 0.9, compare: 3.0, merge: 0.9 };
for (turn = 0; turn < LINES.length; turn++) {
  const line = LINES[turn];
  const userEnd = speak('user', line.say, t);
  const res = await request(app).post(`/api/sessions/${sid}/turn`).set(auth).send({ text: line.say }).expect(200);
  const state = res.body.state;
  if (line.op(ids).kind === 'fork') ids.bbq = state.currentBranchId;
  ev(userEnd + 0.9, { type: 'state', state: withoutReply(state) });
  const kind = KIND[res.body.decision.op.kind];
  if (kind) {
    ev(userEnd + 1.0, { type: 'play', phase: 'start', kind, revision: state.revision - 1 });
    ev(userEnd + 1.0 + ANIM[kind], { type: 'play', phase: 'end', kind, revision: state.revision - 1 });
  }
  const replyStart = userEnd + GAP;
  ev(replyStart + 0.7, { type: 'state', state });
  t = speak('assistant', line.reply, replyStart) + 1.6;
}

const endAt = t + 0.4;
ev(endAt, { type: 'end' });
const end = await request(app).post(`/api/sessions/${sid}/end`).set(auth).expect(200);
const shareId = String(end.body.shareUrl).split('/').pop();
const share = await request(app).get(`/api/share/${shareId}`).expect(200);
ev(endAt + 2.4, { type: 'share', data: share.body });

const out = path.resolve(import.meta.dirname, '..', 'film', 'data');
mkdirSync(out, { recursive: true });
events.sort((a, b) => a.t - b.t);
writeFileSync(path.join(out, 'session.json'), JSON.stringify({ version: 1, offset: 0, standIn: true, events }, null, 1));
// word timings as Remotion captions, the format whisper.cpp's toCaptions() gives for the real recording
const captions = words.map((w) => ({ text: ` ${w.text}`, startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000), timestampMs: Math.round(((w.start + w.end) / 2) * 1000), confidence: null }));
writeFileSync(path.join(out, 'captions.json'), JSON.stringify(captions, null, 1));
console.log(`stand-in: ${events.length} events, ${words.length} words, ends at ${(endAt + 8).toFixed(1)} s`);
for (const e of events.filter((x) => x.type === 'play' && x.phase === 'start')) console.log(`  ${e.kind} at ${e.t}`);
for (const e of events.filter((x) => x.type === 'speech')) console.log(`  ${e.role} ${e.status} ${e.t}`);
