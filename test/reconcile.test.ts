import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, defaultDeps } from '../src/server.js';
import { extendsText, bargeInText, spokenPrefix } from '../src/vapi/reconcile.js';
import { appendTurn } from '../src/tree/tree.js';
import { phantomTail } from '../src/vapi/customLlm.js';
import type { Op, RouteDecision, Router } from '../src/route/types.js';
import type { Responder } from '../src/reply/responder.js';
import { fakeNamer } from './helpers/fakes.js';

/** Distinct replies: "Reply 1. Ok.", "Reply 2. Ok.", ... */
function numberedResponder(): Responder {
  let n = 0;
  return { async *reply() { n += 1; yield `Reply ${n}. `; yield 'Ok.'; } };
}
const R = (n: number) => `Reply ${n}. Ok.`;

vi.spyOn(console, "log").mockImplementation(() => {});
const SECRET = 'test-secret';

describe('extendsText', () => {
  it('true when the new text starts with the prior text, ignoring case and punctuation', () => {
    expect(extendsText('Planning 10 days in Japan March. With 2 friends.', 'Planning 10 days in Japan March.')).toBe(true);
    expect(extendsText('planning 10 days in japan march with 2 friends', 'Planning 10 days in Japan, March.')).toBe(true);
    expect(extendsText('Same words.', 'same words')).toBe(true);
  });
  it('false for unrelated, shorter or mid-word prefixes', () => {
    expect(extendsText('Something else entirely', 'Planning in Japan')).toBe(false);
    expect(extendsText('Plan', 'Planning')).toBe(false);
    expect(extendsText('Planning', 'Planning in Japan')).toBe(false);
    expect(extendsText('anything', '')).toBe(false);
  });
});

describe('spokenPrefix', () => {
  it('matches formatting differences: punctuation, case, number words and digits', () => {
    expect(spokenPrefix('Three people, in Kyoto.', '3 people. In Kyoto.')).toEqual({ text: 'Three people, in Kyoto.', complete: true });
    expect(spokenPrefix('It takes half a day.', 'It takes 0.5 a day.')).toEqual({ text: 'It takes half a day.', complete: true });
    expect(spokenPrefix("Don’t go.", 'dont go')).toEqual({ text: 'Don’t go.', complete: true });
    expect(spokenPrefix('Stay twenty-one days.', 'Stay 21 days.')).toEqual({ text: 'Stay twenty-one days.', complete: true });
    expect(spokenPrefix('Stay 21 days.', 'stay twenty one days')).toEqual({ text: 'Stay 21 days.', complete: true });
  });
  it('returns the generated slice up to the last matched word for a spoken prefix', () => {
    expect(spokenPrefix('Three people, in Kyoto. Then Osaka.', '3 people. In Kyoto.')).toEqual({ text: 'Three people, in Kyoto', complete: false });
    expect(spokenPrefix('Three people, in Kyoto.', '3 people')).toEqual({ text: 'Three people', complete: false });
  });
  it('rejects different words, unrelated replies, mid-word fragments, extra words and empty speech', () => {
    expect(spokenPrefix('Stay in Furano.', 'Stay in Niseko.')).toBeNull();
    expect(spokenPrefix('Stay in Furano.', 'Stay in Fur')).toBeNull();
    expect(spokenPrefix('Stay in Furano.', 'Something else entirely')).toBeNull();
    expect(spokenPrefix('Stay in Furano.', 'Stay in Furano. And more.')).toBeNull();
    expect(spokenPrefix('Stay in Furano.', 'Stay Furano')).toBeNull();
    expect(spokenPrefix('Stay in Furano.', '  ')).toBeNull();
    expect(spokenPrefix('Stay 100 days.', 'Stay one hundred days.')).toBeNull();
  });
});

describe('bargeInText', () => {
  const m = (...p: [string, string][]) => p.map(([role, content]) => ({ role, content }));
  it('returns the user words placed before the cut-off assistant message, after the recorded user text', () => {
    const msgs = m(['user', 'Planning trip'], ['user', 'Sorry.'], ['assistant', 'Sounds great.'], ['user', 'Purano.']);
    expect(bargeInText(msgs, 'Planning trip')).toBe('Sorry.');
  });
  it('is empty when the block before the assistant message is just the recorded text, or does not start with it', () => {
    expect(bargeInText(m(['user', 'Planning trip'], ['assistant', 'Sounds great.']), 'Planning trip')).toBe('');
    expect(bargeInText(m(['user', 'Other words'], ['assistant', 'Sounds great.']), 'Planning trip')).toBe('');
    expect(bargeInText(m(['user', 'Planning trip']), 'Planning trip')).toBe('');
  });
  it('handles the recorded text spread over several user messages and skips empty assistant messages', () => {
    const msgs = m(['user', 'Planning'], ['assistant', ''], ['user', 'trip'], ['user', 'Sorry wait.'], ['assistant', 'Sounds']);
    expect(bargeInText(msgs, 'Planning trip')).toBe('Sorry wait.');
  });
});

/** Routes `correct` on text containing "sorry", `fork` on "new idea", else continue. Records what it saw. */
function textRouter(seen: string[]): Router {
  return {
    async route(input): Promise<RouteDecision> {
      seen.push(input.utterance);
      const op: Op = /sorry/i.test(input.utterance) ? { kind: 'correct' } : /new idea/i.test(input.utterance) ? { kind: 'fork', acknowledge: false } : { kind: 'continue' };
      return { op, intent: null, by: 'jev', ms: 1, reason: '' };
    },
  };
}

async function setup(responder: Responder = numberedResponder()) {
  const seen: string[] = [];
  const deps = defaultDeps({ vapiSecret: SECRET, router: textRouter(seen), responder, namer: fakeNamer(null) });
  const app = createApp(deps);
  const r = await request(app).post('/api/sessions');
  const auth = { Authorization: `Bearer ${r.body.token}` };
  await request(app).post(`/api/sessions/${r.body.sessionId}/bind`).set(auth).send({ callId: 'call-A' }).expect(200);
  const s = deps.sessions.get(r.body.sessionId)!;
  const send = (messages: { role: string; content: string }[]) =>
    request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, messages: [{ role: 'system', content: 'sys' }, ...messages] }).expect(200);
  const sendVoice = (messages: { role: string; content: string }[]) =>
    request(app).post('/vapi/chat/completions').set('x-vapi-secret', SECRET).send({ call: { id: 'call-A' }, stream: true, messages: [{ role: 'system', content: 'sys' }, ...messages] }).expect(200);
  const event = (message: Record<string, unknown>) =>
    request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send({ message: { call: { id: 'call-A' }, ...message } }).expect(200);
  const users = () => s.turns.filter((t) => t.role === 'user').map((t) => t.text);
  const replies = () => s.turns.filter((t) => t.role === 'assistant').map((t) => t.text);
  return { s, send, sendVoice, event, seen, users, replies, deps };
}
const U = (content: string) => ({ role: 'user', content });
const A = (content: string) => ({ role: 'assistant', content });

describe('one user turn per spoken turn', () => {
  it('extends the trailing user turn when the reply was never spoken, and routes on the full text', async () => {
    const { s, send, seen, users, replies } = await setup();
    await send([U('Planning 10 days in Japan March.')]);
    expect(replies()).toHaveLength(1);
    await send([U('Planning 10 days in Japan March.'), A(''), U('With 2 friends.')]);
    await send([U('Planning 10 days in Japan March.'), A(''), U('With 2 friends.'), A(''), U('Mostly Tokyo.')]);
    expect(users()).toEqual(['Planning 10 days in Japan March. With 2 friends. Mostly Tokyo.']);
    expect(replies()).toHaveLength(1);
    expect(seen.at(-1)).toBe('Planning 10 days in Japan March. With 2 friends. Mostly Tokyo.');
    expect(s.revision).toBeGreaterThan(0);
  });

  it('keeps a reply that was spoken and starts a new turn after it', async () => {
    const { send, users, replies } = await setup();
    await send([U('hello there')]);
    await send([U('hello there'), A(R(1)), U('Tokyo')]);
    expect(users()).toEqual(['hello there', 'Tokyo']);
    expect(replies()).toHaveLength(2);
  });

  it('a cut-off reply is trimmed to what was spoken and the next words are a new turn', async () => {
    const { send, users, replies } = await setup();
    await send([U('hello there')]);
    await send([U('hello there'), A('Reply 1.'), U('Tokyo')]);
    expect(users()).toEqual(['hello there', 'Tokyo']);
    expect(replies()[0]).toBe('Reply 1.');
  });

  it('a later turn whose earlier reply was spoken still extends only the unspoken one', async () => {
    const { send, users } = await setup();
    await send([U('a b')]);
    await send([U('a b'), A(R(1)), U('c d')]);
    await send([U('a b'), A(R(1)), U('c d'), A(''), U('e f')]);
    expect(users()).toEqual(['a b', 'c d e f']);
  });

  it('a fork applied for the shorter text is not applied twice', async () => {
    const { s, send, users } = await setup();
    await send([U('hello')]);
    await send([U('hello'), A(R(1)), U('new idea about food')]);
    expect(Object.keys(s.branches)).toHaveLength(2);
    await send([U('hello'), A(R(1)), U('new idea about food'), A(''), U('and more food')]);
    expect(Object.keys(s.branches)).toHaveLength(2);
    expect(users()).toEqual(['hello', 'new idea about food and more food']);
  });

  it('a continue that becomes a correction on the longer text is applied once, with nothing left of the short turn', async () => {
    const { s, send, users } = await setup();
    await send([U('Planning a trip to Mexico')]);
    expect(Object.keys(s.branches)).toHaveLength(1);
    await send([U('Planning a trip to Mexico'), A(''), U('Sorry, not Mexico, Peru')]);
    expect(Object.keys(s.branches)).toHaveLength(2);
    expect(users()).toEqual(['Planning a trip to Mexico Sorry, not Mexico, Peru']);
    expect(s.branches[Object.keys(s.branches)[0]!]!.status).toBe('faded');
    expect(s.turns.filter((t) => t.role === 'user').every((t) => t.kind === 'correction')).toBe(true);
  });

  it('a fork that becomes a correction on the longer text leaves no half-applied fork', async () => {
    const { s, send, users } = await setup();
    await send([U('hello')]);
    await send([U('hello'), A(R(1)), U('new idea')]);
    expect(Object.keys(s.branches)).toHaveLength(2);
    await send([U('hello'), A(R(1)), U('new idea'), A(''), U('sorry no')]);
    expect(Object.keys(s.branches)).toHaveLength(2);
    expect(users()).toEqual(['hello', 'new idea sorry no']);
    expect(Object.values(s.branches).filter((b) => b.origin === 'fork')).toHaveLength(0);
    expect(Object.values(s.branches).filter((b) => b.origin === 'correction')).toHaveLength(1);
  });

  it('removes an unspoken reply even without an undo snapshot, and keeps only the words not yet recorded', async () => {
    const { s, send, users, replies } = await setup();
    appendTurn(s, s.currentBranchId, 'user', 'Remind me by Raven.', Date.now());
    appendTurn(s, s.currentBranchId, 'assistant', "I didn't quite catch that.", Date.now());
    await send([U('Remind me by Raven.'), A(''), U('Where we were.')]);
    expect(users()).toEqual(['Remind me by Raven.', 'Where we were.']);
    expect(replies().some((t) => t.includes('quite catch'))).toBe(false);
  });
});

describe('a user turn with no reply recorded after it', () => {
  it('is replaced by the longer text (a silent reply records no assistant turn)', async () => {
    const { s, send, seen, users, replies } = await setup();
    appendTurn(s, s.currentBranchId, 'user', 'Planning 10 days in Japan March.', Date.now());
    await send([U('Planning 10 days in Japan March.'), A(''), U('With 2 friends. Mostly Tokyo, and Kyoto.')]);
    expect(users()).toEqual(['Planning 10 days in Japan March. With 2 friends. Mostly Tokyo, and Kyoto.']);
    expect(seen.at(-1)).toBe('Planning 10 days in Japan March. With 2 friends. Mostly Tokyo, and Kyoto.');
    expect(replies()).toHaveLength(1);
  });
  it('leaves an unrelated trailing user turn alone', async () => {
    const { s, send, users } = await setup();
    appendTurn(s, s.currentBranchId, 'user', 'Something else.', Date.now());
    await send([U('Planning in Japan.')]);
    expect(users()).toEqual(['Something else.', 'Planning in Japan.']);
  });
});

describe('words said over the assistant are kept', () => {
  it('puts user messages before the cut-off assistant message into the new turn and routes on them', async () => {
    const { send, seen, users, replies } = await setup();
    await send([U('Planning trip to Mexico')]);
    await send([U('Planning trip to Mexico'), U('Sorry.'), A('Reply 1.'), U('Purano. Not Mexico.')]);
    expect(users()).toEqual(['Planning trip to Mexico', 'Sorry. Purano. Not Mexico.']);
    expect(seen.at(-1)).toBe('Sorry. Purano. Not Mexico.');
    expect(replies()[0]).toBe('Reply 1.');
  });
});

describe('a phantom tail after a cut reply', () => {
  const plan = 'Winter is lovely here. Do you want sights or a slower pace? Tell me which.';
  const planner: Responder = { async *reply() { yield 'Winter is lovely here. '; yield 'Do you want sights or a slower pace? '; yield 'Tell me which.'; } };
  const first = 'I am planning a trip, Tokyo and Kyoto for a week, 3 people.';
  /** The plan reply plays, is cut after its first sentence, and the webhook shows no new speech from the caller. */
  async function cutPlan() {
    const t = await setup(planner);
    await t.sendVoice([A('Hi.'), U(first)]);
    await t.event({ type: 'speech-update', role: 'assistant', status: 'started', turn: 1 });
    await t.event({ type: 'user-interrupted' });
    await t.event({ type: 'speech-update', role: 'assistant', status: 'stopped' });
    await t.event({ type: 'transcript', transcriptType: 'partial', role: 'user', transcript: 'Kyoto three' }); // the phantom: a partial that never finalizes
    await t.event({ type: 'transcript', transcriptType: 'final', role: 'assistant', transcript: 'Winter is lovely here.' });
    return t;
  }

  it('stores nothing and resumes the reply from the first unheard word', async () => {
    const { s, sendVoice, users, replies } = await cutPlan();
    const out = (await sendVoice([A('Hi.'), U(`${first} Kyoto three`)])).text;
    expect(out).toContain('Do you want sights or a slower pace?');
    expect(out).not.toContain('Winter is lovely');
    expect(users()).toEqual([first]);
    expect(replies()).toEqual([plan]);
    expect(Object.keys(s.branches)).toHaveLength(1);
  });

  it('a phantom that did not interrupt (completed reply) changes nothing in any of the three request shapes', async () => {
    const shapes: [string, () => unknown[]][] = [
      ['appended after the opening message', () => [A('Hi.'), U(`${first} Kyoto`)]],
      ['a new user message after the reply', () => [A('Hi.'), U(first), A(plan), U('Kyoto')]],
      ['appended to the user message before the reply', () => [A('Hi.'), U(`${first} Kyoto`), A(plan)]],
    ];
    for (const [name, build] of shapes) {
      for (const genuine of [false, true]) {
        const { sendVoice, event, users, replies } = await setup(planner);
        await sendVoice([A('Hi.'), U(first)]);
        await event({ type: 'speech-update', role: 'assistant', status: 'started', turn: 1 });
        await event({ type: 'speech-update', role: 'assistant', status: 'stopped' });
        await event({ type: 'transcript', transcriptType: 'final', role: 'assistant', transcript: plan });
        await event({ type: 'transcript', transcriptType: 'partial', role: 'user', transcript: 'Kyoto' });
        if (genuine) {
          await event({ type: 'speech-update', role: 'user', status: 'started' });
          await event({ type: 'transcript', transcriptType: 'final', role: 'user', transcript: 'Kyoto' });
        }
        const out = (await sendVoice(build() as never)).text;
        if (genuine) {
          expect(users().at(-1), name).toMatch(/Kyoto$/); // a real start and final: answered
          expect(users(), name).not.toEqual([first]);
        }
        else {
          expect(users(), name).toEqual([first]);
          expect(replies(), name).toEqual([plan]);
          expect(out, name).not.toContain('Winter');
        }
      }
    }
  });

  it('answers a real one-word answer that has a user final as a new turn', async () => {
    const { sendVoice, event, users } = await cutPlan();
    await event({ type: 'transcript', transcriptType: 'final', role: 'user', transcript: 'Kyoto' });
    await sendVoice([A('Hi.'), U(first), A('Winter is lovely here.'), U('Kyoto')]);
    expect(users()).toEqual([first, 'Kyoto']);
  });

  it.each(['appended-after-old-assistant', 'after-complete-assistant', 'before-complete-assistant'])(
    'does not replay a classified phantom from retained history when genuine speech grows (%s)',
    async (shape) => {
      const { sendVoice, event, seen, users } = await setup(planner);
      await sendVoice([A('Hi.'), U(first)]);
      await event({ type: 'speech-update', role: 'assistant', status: 'started', turn: 1 });
      await event({ type: 'speech-update', role: 'assistant', status: 'stopped' });
      await event({ type: 'transcript', transcriptType: 'final', role: 'assistant', transcript: plan });
      await event({ type: 'transcript', transcriptType: 'partial', role: 'user', transcript: 'Kyoto' });

      const phantomHistory = shape === 'appended-after-old-assistant'
        ? [A('Hi.'), U(`${first} Kyoto`)]
        : shape === 'after-complete-assistant'
          ? [A('Hi.'), U(first), A(plan), U('Kyoto')]
          : [A('Hi.'), U(`${first} Kyoto`), A(plan)];
      // A retry may enter the handler while the first request is still waiting for a late transcript.
      await Promise.all([sendVoice(phantomHistory), sendVoice(phantomHistory)]);
      expect(users()).toEqual([first]);

      const real = 'Sorry Furano';
      await event({ type: 'speech-update', role: 'user', status: 'started' });
      await event({ type: 'transcript', transcriptType: 'final', role: 'user', transcript: real });
      await sendVoice([...phantomHistory, A(''), U(real)]);
      expect(seen.at(-1)).toBe(real);
      expect(users()).toEqual([first, real]);

      const growing = `${real} not Niseko and please keep the quiet evenings`;
      await event({ type: 'speech-update', role: 'user', status: 'started' });
      await event({ type: 'transcript', transcriptType: 'final', role: 'user', transcript: growing });
      const growingHistory = [...phantomHistory, A(''), U(real), A(''), U('not Niseko and please keep the quiet evenings')];
      await sendVoice(growingHistory);
      expect(seen.at(-1)).toBe(growing);
      expect(users().at(0)).toBe(first);
      expect(users().at(-1)).toBe(growing);
      expect(users().slice(1, -1).every((text) => text === real)).toBe(true);

      await event({ type: 'speech-update', role: 'assistant', status: 'started', turn: 2 });
      await event({ type: 'transcript', transcriptType: 'final', role: 'assistant', transcript: plan });
      await event({ type: 'speech-update', role: 'assistant', status: 'stopped' });
      await event({ type: 'transcript', transcriptType: 'partial', role: 'user', transcript: 'evenings' });
      const secondPhantom = [...growingHistory, A(plan), U('evenings')];
      const beforeSecondPhantom = seen.length;
      await sendVoice(secondPhantom);
      expect(seen).toHaveLength(beforeSecondPhantom);

      const next = 'Keep skiing most mornings';
      await event({ type: 'speech-update', role: 'user', status: 'started' });
      await event({ type: 'transcript', transcriptType: 'final', role: 'user', transcript: next });
      await sendVoice([...secondPhantom, A(''), U(next)]);
      expect(seen.at(-1)).toBe(next);
      expect(users().at(0)).toBe(first);
      expect(users().at(-1)).toBe(next);
    },
  );

  it.each(['interruption', 'genuine final'])('rechecks events arriving during the grace wait (%s)', async (late) => {
    const { sendVoice, event, replies, deps, s } = await setup(planner);
    await sendVoice([A('Hi.'), U(first)]);
    await event({ type: 'speech-update', role: 'assistant', status: 'started', turn: 1 });
    await event({ type: 'transcript', transcriptType: 'final', role: 'assistant', transcript: 'Winter is lovely here.' });
    await event({ type: 'transcript', transcriptType: 'partial', role: 'user', transcript: 'Kyoto' });
    const lateEvidence = new Promise<void>((resolve) => setTimeout(() => {
      if (late === 'interruption') {
        deps.spoken.interrupted(s.id, Date.now());
        deps.spoken.assistantTranscript(s.id, 'Do you want sights', true, Date.now() + 1);
        deps.spoken.assistantStopped(s.id, Date.now() + 2);
      } else {
        deps.spoken.userStarted(s.id, Date.now());
        deps.spoken.userTranscript(s.id, true, Date.now() + 1, 'Niseko');
      }
      resolve();
    }, 100));
    const [resumed] = await Promise.all([
      phantomTail(s, { messages: [A('Hi.'), U(`${first} Kyoto`)] }, deps),
      lateEvidence,
    ]);
    if (late === 'interruption') {
      expect(resumed).toContain('or a slower pace?');
      expect(resumed).not.toContain('Winter is lovely here.');
    } else expect(resumed).toBeNull();
    expect(replies()).toEqual([plan]);
  });
});

describe('words said over a reply whose spoken text is formatted differently', () => {
  it('recovers the words placed before an assistant message that matches only after normalization', async () => {
    const { s, send, seen, users, replies } = await setup();
    await send([U('Planning trip to Mexico')]);
    const rev = s.revision;
    await send([U('Planning trip to Mexico'), U('Sorry.'), A('reply one. ok.'), U('Purano. Not Mexico.')]);
    expect(users()).toEqual(['Planning trip to Mexico', 'Sorry. Purano. Not Mexico.']);
    expect(seen.at(-1)).toBe('Sorry. Purano. Not Mexico.');
    expect(replies()[0]).toBe(R(1)); // spoken in full: text untouched
    expect(s.revision).toBeGreaterThan(rev);
  });
});

describe('a reply cut by the caller', () => {
  it('a reply cut by the caller is stored only up to the words Vapi transcribed', async () => {
    const long = 'A week split between Tokyo and Kyoto works well. Winter keeps the crowds light.';
    const { sendVoice, event, replies } = await setup({ async *reply() { yield `${long} `; } });
    await sendVoice([U('hello there')]);
    await event({ type: 'speech-update', role: 'assistant', status: 'started', turn: 2 });
    await event({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'A week split between Tokyo and Kyoto' });
    await event({ type: 'user-interrupted' });
    await sendVoice([U('hello there'), A('Right.'), U('Kyoto')]);
    expect(replies()[0]).toBe('A week split between Tokyo and Kyoto');
  });

  it('a reply heard in full is kept whole when the transcripts misspell a word and the caller interrupts at the end', async () => {
    const full = 'The snow is dry and light, which is great for skiing, but it does mean real layers, good boots and gloves for the three of you.';
    const { sendVoice, event, replies } = await setup({ async *reply() { yield `${full} `; } });
    await sendVoice([U('hello there')]);
    await event({ type: 'speech-update', role: 'assistant', status: 'started', turn: 1 });
    await event({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'The snow is dry and white, which is great for skiing, but it does mean real layers, good boots and gloves for the 3 of' });
    await event({ type: 'user-interrupted' });
    await sendVoice([U('hello there'), A('Right.'), U('Kyoto')]);
    expect(replies()[0]).toBe(full);
  });
});

describe('a sentence spoken in pieces', () => {
  it('stacked fillers and a superseded reply still make one correction branch', async () => {
    const { s, send, event, seen, users, replies } = await setup();
    await send([U('hello there')]);
    await send([U('hello there'), A(R(1)), U('Sorry.')]);
    // The caller kept talking before hearing the reply to "Sorry.": webhook speech start, no model playback.
    await event({ type: 'speech-update', role: 'user', status: 'started' });
    await send([U('hello there'), A(R(1)), U('Sorry.'), A(`Right. Hm, okay. ${R(2)}`), U('not that one, the other.')]);
    expect(Object.values(s.branches).filter((b) => b.origin === 'correction')).toHaveLength(1);
    expect(users().at(-1)).toBe('Sorry. not that one, the other.');
    expect(seen.at(-1)).toBe('Sorry. not that one, the other.');
    expect(replies()).toHaveLength(2);
  });

  it('a heard reply is never undone, even with no playback event and an earlier noise start', async () => {
    const { send, event, users } = await setup();
    await event({ type: 'speech-update', role: 'user', status: 'started' }); // noise before the first turn
    await send([U('hello there')]);
    await new Promise((r) => setTimeout(r, 300)); // the caller hears the reply, then speaks
    await event({ type: 'speech-update', role: 'user', status: 'started' });
    await send([U('hello there'), A(R(1)), U('what about tomorrow')]);
    expect(users()).toEqual(['hello there', 'what about tomorrow']);
  });
});

describe('words said over a reply after a correction (live call 2)', () => {
  it('keeps the correction and its heard reply and makes "Wait." its own turn: one correction branch', async () => {
    let n = 0;
    const { s, sendVoice, event, users, replies } = await setup({ async *reply() { n += 1; yield `Reply ${n} is quieter and the snow is dry. `; yield 'Are the three of you skiing?'; } });
    await sendVoice([U('hello there')]);
    await sendVoice([U('hello there'), A('Reply 1 is quieter and the snow is dry.'), U('Sorry. Not that one.')]);
    await event({ type: 'speech-update', role: 'assistant', status: 'started', turn: 3 });
    await event({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'Reply 2 is quieter and the snow is' });
    await event({ type: 'user-interrupted' });
    // Vapi appends "Wait." to the correction and still shows the earlier reply as the last assistant message.
    await sendVoice([U('hello there'), A('Reply 1 is quieter and the snow is dry.'), U('Sorry. Not that one. Wait.')]);
    expect(Object.values(s.branches).filter((b) => b.origin === 'correction')).toHaveLength(1);
    expect(users().slice(-2)).toEqual(['Sorry. Not that one.', 'Wait.']);
    expect(replies()[1]).toBe('Reply 2 is quieter and the snow is');
  });
});

describe('VAPI_CAPTURE_DIR', () => {
  afterEach(() => { delete process.env.VAPI_CAPTURE_DIR; });
  it('writes each request body messages (not headers) to a json file, only when set', async () => {
    const { send } = await setup();
    await send([U('no capture')]);
    const dir = mkdtempSync(join(tmpdir(), 'vapicap-'));
    expect(readdirSync(dir)).toHaveLength(0);
    process.env.VAPI_CAPTURE_DIR = dir;
    await send([U('hello'), { role: 'assistant', content: 'Hi', secondsFromStart: 3.2 } as never, U('again')]);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(dir, files[0]!), 'utf8');
    expect(text).not.toContain(SECRET);
    const j = JSON.parse(text);
    expect(j.messages.map((x: { role: string }) => x.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(j.messages[2]).toMatchObject({ content: 'Hi', secondsFromStart: 3.2 });
  });
});
