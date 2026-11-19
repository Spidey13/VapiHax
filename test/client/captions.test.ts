import { describe, it, expect } from 'vitest';
import { emptyCaptions, addFinal, setPartial, clearLive, prune, captionRows, pendingPath, revealPath, revealedText, speechEvent, setGate, openReplies, markSeen, greetingRows, playbackEvent, transcriptRows, syncCaptionPath } from '../../public/js/captions.js';

const turn = (id: string, role: string, text = id) => ({ id, role, text });

describe('captions', () => {
  it('a final persists while the server has not recorded it', () => {
    let st = addFinal(emptyCaptions(), 'user', 'hello', []);
    expect(captionRows(st, [])).toEqual([{ role: 'user', text: 'hello', live: false }]);
    st = prune(st, [turn('a1', 'assistant')]); // other role does not clear
    expect(captionRows(st, [turn('a1', 'assistant')])).toHaveLength(1);
  });
  it('held multi-segment speech stays visible in order', () => {
    let st = emptyCaptions();
    st = addFinal(st, 'user', 'first part', []);
    st = addFinal(st, 'user', 'second part', []);
    expect(captionRows(st, []).map((r: any) => r.text)).toEqual(['first part second part']);
  });
  it('a recorded turn clears the matching finals only', () => {
    let st = addFinal(emptyCaptions(), 'user', 'one', []);
    st = addFinal(st, 'user', 'two', []);
    const rows = captionRows(st, [turn('u1', 'user', 'one two')]);
    expect(rows).toEqual([]);
  });
  it('an assistant final is not retained and clears the assistant live row', () => {
    let st = setPartial(emptyCaptions(), 'assistant', 'hi the');
    st = addFinal(st, 'assistant', 'hi there', []);
    expect(st.finals).toEqual([]);
    expect(captionRows(st, [turn('u1', 'user')])).toEqual([{ role: 'assistant', text: 'hi there', live: false }]);
  });
  it('a user live row survives an assistant final', () => {
    let st = setPartial(emptyCaptions(), 'user', 'hal');
    st = addFinal(st, 'assistant', 'hi there', []);
    expect(captionRows(st, [turn('u1', 'user')])).toEqual([
      { role: 'user', text: 'hal', live: true },
      { role: 'assistant', text: 'hi there', live: false },
    ]);
  });
  it('finals after a recorded turn survive (base lists existing turns)', () => {
    const path = [turn('u1', 'user')];
    const st = addFinal(emptyCaptions(), 'user', 'next', path);
    expect(captionRows(st, path)).toHaveLength(1);
    expect(captionRows(st, [...path, turn('u2', 'user')])).toHaveLength(0);
  });
  it('partial replaces only the trailing live row', () => {
    let st = addFinal(emptyCaptions(), 'user', 'done', []);
    st = setPartial(st, 'user', 'hal');
    st = setPartial(st, 'user', 'half way');
    expect(captionRows(st, [])).toEqual([{ role: 'user', text: 'done half way', live: true }]);
    expect(captionRows(clearLive(st), [])).toEqual([{ role: 'user', text: 'done', live: false }]);
  });
  it('a final replaces the live row of the same role', () => {
    let st = setPartial(emptyCaptions(), 'user', 'hal');
    st = addFinal(st, 'user', 'hello', []);
    expect(captionRows(st, [])).toEqual([{ role: 'user', text: 'hello', live: false }]);
  });
  it('the spoken reply is not shown twice once the server has recorded it', () => {
    const st = setPartial(emptyCaptions(), 'assistant', 'An AI made by');
    const path = [turn('u1', 'user'), turn('a1', 'assistant', 'You are speaking with Claude, an AI made by Anthropic.')];
    expect(captionRows(st, path)).toEqual([]);
  });
  it('the spoken reply shows live while the server has not recorded it yet', () => {
    const st = setPartial(emptyCaptions(), 'assistant', 'Let me');
    expect(captionRows(st, [turn('u1', 'user')])).toEqual([{ role: 'assistant', text: 'Let me', live: true }]);
  });
});

describe('one user row', () => {
  it('finals and the partial of one turn read as one growing row', () => {
    let st = addFinal(emptyCaptions(), 'user', 'But', []);
    st = addFinal(st, 'user', 'actually,', []);
    st = setPartial(st, 'user', 'what if we');
    expect(captionRows(st, [])).toEqual([{ role: 'user', text: 'But actually, what if we', live: true }]);
  });
});

const REPLY = 'Hokkaido in March still has solid snow. Especially early in the month. Are all three of you into skiing?';
const reply = () => [turn('u1', 'user'), turn('a1', 'assistant', REPLY)];
const voiceOn = () => setGate(emptyCaptions(), true);
const shown = (st: any, path: any[], now = st.now) => revealPath(st, path, now).filter((t: any) => t.role === 'assistant').map((t: any) => t.text);

describe('revealedText', () => {
  // Replaced: these expected the rest of an unfinished sentence to appear (forward rounding); only heard words may show.
  it('while speaking shows only sentences whose words were all confirmed', () => {
    expect(revealedText(REPLY, 'Hokkaido in March', true)).toBe('');
    expect(revealedText(REPLY, 'Hokkaido in March still has solid snow. Especially', true)).toBe('Hokkaido in March still has solid snow.');
    expect(revealedText('First sentence has many words. Next one.', 'First', true)).toBe('');
    expect(revealedText('First sentence. Next one.', 'First sentence.', true)).toBe('First sentence.');
  });
  it('keeps closing quotes with a completed sentence', () => {
    expect(revealedText('He said "stop." Then left.', 'He said stop', true)).toBe('He said "stop."');
  });
  it('cuts at the last spoken word once speech has stopped', () => {
    expect(revealedText(REPLY, 'Hokkaido in March still has solid snow. Especially early', false)).toBe('Hokkaido in March still has solid snow. Especially early');
  });
  it('shows nothing before a word is spoken', () => {
    expect(revealedText(REPLY, '', true)).toBe('');
  });
  // Replaced: the old "within two words of the end -> whole reply" shortcut revealed unheard words.
  it('tolerates a misheard word but never completes a dropped tail', () => {
    expect(revealedText(REPLY, 'Hokaido in March still has solid snow. Especially early in the month. Are all three of you into', false)).toBe('Hokkaido in March still has solid snow. Especially early in the month. Are all three of you into');
  });
  it('not speaking keeps punctuation attached to the last matched word', () => {
    expect(revealedText('First sentence. Next one.', 'First sentence', false)).toBe('First sentence.');
  });
});

describe('a reply under a live call', () => {
  // Replaced: a half-confirmed first sentence used to show in full.
  it('is hidden until it is spoken, then grows by confirmed sentence', () => {
    let st: any = voiceOn();
    expect(shown(st, reply())).toEqual([]);
    st = speechEvent(st, 'assistant', 'started', reply());
    st = addFinal(st, 'assistant', 'Hokkaido in March still', reply());
    expect(shown(st, reply())).toEqual([]);
    st = addFinal(st, 'assistant', 'has solid snow.', reply());
    expect(shown(st, reply())).toEqual(['Hokkaido in March still has solid snow.']);
  });
  it('shows only what was heard when the user cuts in, and keeps it after the server records their turn', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', reply());
    st = addFinal(st, 'assistant', 'Hokkaido in March still has solid snow. Especially early', reply());
    st = speechEvent(st, 'assistant', 'stopped', reply());
    st = speechEvent(st, 'user', 'started', reply());
    const later = [...reply(), turn('u2', 'user'), turn('a2', 'assistant', 'Sure.')];
    expect(shown(st, later)[0]).toBe('Hokkaido in March still has solid snow. Especially early');
  });
  it('a late final after stop still completes the reply', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', reply());
    st = addFinal(st, 'assistant', 'Hokkaido in March still has solid snow. Especially early in the month.', reply());
    st = speechEvent(st, 'assistant', 'stopped', reply());
    st = addFinal(st, 'assistant', 'Are all three of you into skiing?', reply());
    expect(shown(st, reply())).toEqual([REPLY]);
  });
  it('a reply already on screen before the call spoke it is never hidden', () => {
    expect(shown(markSeen(voiceOn(), reply()), reply())).toEqual([REPLY]);
  });
  it('shows at once without a call, and for a typed turn', () => {
    expect(shown(emptyCaptions(), reply())).toEqual([REPLY]);
    expect(shown(openReplies(voiceOn()), reply())).toEqual([REPLY]);
  });
  it('keeps the greeting as the first row after the user starts', () => {
    let st: any = voiceOn();
    st = addFinal(st, 'assistant', 'Hi.', []);
    st = addFinal(st, 'assistant', 'What are you thinking about?', []);
    expect(captionRows(st, [])).toEqual([{ role: 'assistant', text: 'Hi. What are you thinking about?', live: false }]);
    st = speechEvent(st, 'user', 'started', []);
    st = addFinal(st, 'user', 'Japan', []);
    expect(captionRows(st, [])).toEqual([{ role: 'user', text: 'Japan', live: false }]);
    expect(greetingRows(st, [])).toEqual([{ role: 'assistant', text: 'Hi. What are you thinking about?', live: false }]);
    expect(greetingRows(st, [turn('u1', 'user')])).toHaveLength(1);
  });
  it('drops a stale spoken tail when the user starts', () => {
    let st: any = setPartial(voiceOn(), 'assistant', 'skiing');
    st = speechEvent(st, 'user', 'started', [turn('u1', 'user')]);
    expect(captionRows(st, [turn('u1', 'user')])).toEqual([]);
  });
});

describe('stale lines in a real session', () => {
  it('drops a user partial or final the recorded turn already covers', () => {
    const path = [turn('u1', 'user', 'With 2 friends. Mostly Tokyo, and Kyoto. Kyoto.')];
    expect(captionRows(setPartial(emptyCaptions(), 'user', 'Kyoto.', path), path)).toEqual([]);
    expect(captionRows(addFinal(emptyCaptions(), 'user', 'and Kyoto.', path), path)).toEqual([]);
    expect(captionRows(setPartial(emptyCaptions(), 'user', 'Kyoto next', path), path)).toHaveLength(1);
  });
  it('late assistant captions after the user cut in do not show, until it speaks again', () => {
    const path = [turn('u1', 'user'), turn('a1', 'assistant', 'A small ryokan near Niseko with skiing most mornings.')];
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', path);
    st = addFinal(st, 'assistant', 'A small ryokan near', path);
    st = speechEvent(st, 'assistant', 'stopped', path);
    st = speechEvent(st, 'user', 'started', path);
    const next = [...path, turn('u2', 'user', 'Not Mexico')];
    st = addFinal(st, 'assistant', 'with skiing most', next);
    st = setPartial(st, 'assistant', 'skiing', next);
    expect(captionRows(st, next).filter((r: any) => r.role === 'assistant')).toEqual([]);
    expect(shown(st, next)).toEqual(['A small ryokan near']);
    st = speechEvent(st, 'assistant', 'started', next);
    st = addFinal(st, 'assistant', 'Got it', next);
    expect(captionRows(st, next)).toEqual([{ role: 'assistant', text: 'Got it', live: false }]);
  });
  it('a reply recorded after the user started talking, and never spoken, stays hidden', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'user', 'started', [turn('u1', 'user')]);
    const recorded = [turn('u1', 'user'), turn('a1', 'assistant', "I didn't quite catch that.")];
    expect(shown(st, recorded)).toEqual([]);
    expect(shown(st, [...recorded, turn('u2', 'user', 'Remind me')])).toEqual([]);
  });
  it('a reply no one spoke is hidden once the next user turn is recorded', () => {
    const st: any = voiceOn();
    expect(shown(st, [turn('u1', 'user'), turn('a1', 'assistant', 'Never said.'), turn('u2', 'user')])).toEqual([]);
  });
});

describe('pendingPath', () => {
  it('appends the incoming sheet turns the shown one lacks', () => {
    const shown = [turn('1', 'user'), turn('2', 'assistant')];
    const next = [turn('1', 'user'), turn('2', 'assistant'), turn('3', 'user'), turn('4', 'assistant')];
    expect(pendingPath(shown, next).map((t) => t.id)).toEqual(['1', '2', '3', '4']);
  });
  it('does not duplicate when paths are equal', () => {
    const p = [turn('1', 'user')];
    expect(pendingPath(p, p)).toEqual(p);
  });
});

describe('a reply is never left cut inside a word', () => {
  const MERGE = 'The combined plan keeps your ten days in March with two friends across Tokyo and Kyoto, and adds skiing in Furano, then ends in Osaka.';
  const path = () => [turn('u1', 'user'), turn('a1', 'assistant', MERGE)];
  // Replaced: a stop alone used to reveal the whole reply; it now shows through the last heard word.
  it('a stop alone does not reveal the unheard rest of the reply', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', path());
    st = addFinal(st, 'assistant', 'The combined plan keeps your ten days in March with two friends across Tokyo and Kyoto, and adds skiing in', path());
    st = setPartial(st, 'assistant', 'Fur', path());
    st = speechEvent(st, 'assistant', 'stopped', path());
    expect(shown(st, path())).toEqual(['The combined plan keeps your ten days in March with two friends across Tokyo and Kyoto, and adds skiing in']);
  });
  it('keeps revealing by confirmed sentence if the speech goes on after a pause', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', reply());
    st = addFinal(st, 'assistant', 'Hokkaido in March still has solid snow.', reply());
    st = speechEvent(st, 'assistant', 'stopped', reply());
    st = speechEvent(st, 'assistant', 'started', reply());
    expect(shown(st, reply())).toEqual(['Hokkaido in March still has solid snow.']);
  });
  // Replaced: natural completion used to show the whole reply; now only the transcript or the last playback event's text.
  it('a user who starts talking long after the reply ended keeps what the last playback event covered', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', path(), 1000);
    st = playbackEvent(st, { turn: 1, text: 'The combined plan keeps your ten days in March' });
    st = playbackEvent(st, { turn: 1, text: 'The combined plan keeps your ten days in March with two friends across Tokyo and Kyoto,' });
    st = addFinal(st, 'assistant', 'The combined plan keeps your ten days', path());
    st = speechEvent(st, 'assistant', 'stopped', path(), 2000);
    st = speechEvent(st, 'user', 'started', path(), 9000);
    expect(shown(st, path())).toEqual(['The combined plan keeps your ten days in March with two friends across Tokyo and Kyoto,']);
  });
  it('a user who starts talking long after, with no playback event, keeps only the heard words', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', path(), 1000);
    st = addFinal(st, 'assistant', 'The combined plan keeps your ten days', path());
    st = speechEvent(st, 'assistant', 'stopped', path(), 2000);
    st = speechEvent(st, 'user', 'started', path(), 9000);
    expect(shown(st, path())).toEqual(['The combined plan keeps your ten days']);
  });
  it('a user cutting in while it speaks leaves it cut at a word boundary', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', path(), 1000);
    st = addFinal(st, 'assistant', 'The combined plan keeps your ten days in March with two friends across Tokyo and Kyoto, and adds skiing in', path());
    st = setPartial(st, 'assistant', 'Fur', path());
    st = speechEvent(st, 'user', 'started', path(), 1500);
    const [t] = shown(st, path());
    expect(t).toBe('The combined plan keeps your ten days in March with two friends across Tokyo and Kyoto, and adds skiing in');
    expect(MERGE.startsWith(t + ' ')).toBe(true);
  });
  it('an unrecorded spoken tail is not shown cut inside a word once speech stopped', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', [turn('u1', 'user')]);
    st = addFinal(st, 'assistant', 'and adds skiing in', [turn('u1', 'user')]);
    st = setPartial(st, 'assistant', 'Fur', [turn('u1', 'user')]);
    st = speechEvent(st, 'assistant', 'stopped', [turn('u1', 'user')]);
    expect(captionRows(st, [turn('u1', 'user')])).toEqual([{ role: 'assistant', text: 'and adds skiing in', live: false }]);
  });
});

const PB = (turn: number, text: string) => ({ turn, text, source: 'model' });

describe('playback events', () => {
  const R = 'Sure thing. Hokkaido has deep snow in March. Are you skiing?';
  const rp = () => [turn('u1', 'user'), turn('a1', 'assistant', R)];
  it('the current chunk is not proven played: a single event shows nothing', () => {
    const st = playbackEvent(voiceOn(), PB(1, 'Sure thing. Hokkaido has deep snow in March. Are you skiing?'));
    expect(shown(st, rp())).toEqual([]);
  });
  it('a later chunk proves the earlier text played, and never advances past it', () => {
    let st: any = voiceOn();
    st = playbackEvent(st, PB(1, 'Sure thing.'));
    st = playbackEvent(st, PB(1, 'Sure thing. Hokkaido has deep snow in March.'));
    expect(shown(st, rp())).toEqual(['Sure thing.']);
    st = playbackEvent(st, PB(1, 'Sure thing. Hokkaido has deep snow in March. Are you skiing?'));
    expect(shown(st, rp())).toEqual(['Sure thing. Hokkaido has deep snow in March.']);
  });
  it('a spoken filler before the recorded reply does not block coverage', () => {
    let st: any = voiceOn();
    st = playbackEvent(st, PB(1, 'Hmm, okay.'));
    st = playbackEvent(st, PB(1, 'Hmm, okay. Sure thing. Hokkaido'));
    st = playbackEvent(st, PB(1, 'Hmm, okay. Sure thing. Hokkaido has deep snow'));
    expect(shown(st, rp())).toEqual(['Sure thing. Hokkaido']);
  });
  it('ignores duplicate, stale and malformed events', () => {
    let st: any = voiceOn();
    st = playbackEvent(st, PB(2, 'Sure thing.'));
    expect(playbackEvent(st, PB(2, 'Sure thing.'))).toBe(st);
    expect(playbackEvent(st, PB(1, 'Old reply.'))).toBe(st);
    expect(playbackEvent(st, { turn: 'x', text: 'a' } as any)).toBe(st);
    expect(playbackEvent(st, { turn: 2, text: 5 } as any)).toBe(st);
    expect(playbackEvent(st, PB(2, 'Something else entirely'))).toBe(st); // same turn, not an extension
  });
  it('flush tags are stripped from playback text', () => {
    let st: any = voiceOn();
    st = playbackEvent(st, PB(1, 'Sure thing. <flush />'));
    st = playbackEvent(st, PB(1, 'Sure thing. <flush /> Hokkaido has deep snow'));
    expect(shown(st, rp())).toEqual(['Sure thing.']);
  });
  it('a new turn clears the earlier reply spoken words', () => {
    let st: any = voiceOn();
    st = playbackEvent(st, PB(0, 'Hi there.'));
    st = addFinal(st, 'assistant', 'Sure thing. Hokkaido has deep snow in March.', rp());
    expect(shown(st, rp())).toEqual(['Sure thing. Hokkaido has deep snow in March.']);
    st = playbackEvent(st, PB(1, 'Next reply'));
    expect(shown(st, rp())).toEqual([]);
  });
  it('a late final after an interruption does not reveal more', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', rp());
    st = addFinal(st, 'assistant', 'Sure thing.', rp());
    st = speechEvent(st, 'user', 'started', rp(), 5000);
    st = addFinal(st, 'assistant', 'Hokkaido has deep snow in March.', rp());
    expect(shown(st, rp())).toEqual(['Sure thing.']);
  });
  it('a late final after a natural stop still extends the reply', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', rp(), 1000);
    st = addFinal(st, 'assistant', 'Sure thing.', rp());
    st = speechEvent(st, 'assistant', 'stopped', rp(), 2000);
    expect(shown(st, rp())).toEqual(['Sure thing.']);
    st = addFinal(st, 'assistant', 'Hokkaido has deep snow in March.', rp());
    expect(shown(st, rp())).toEqual(['Sure thing. Hokkaido has deep snow in March.']);
  });
  it('an interrupted reply freezes at the transcript/played reveal, not the last chunk', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', rp(), 1000);
    st = playbackEvent(st, PB(1, 'Sure thing.'), 1050);
    st = playbackEvent(st, PB(1, 'Sure thing. Hokkaido has deep snow in March.'), 1100);
    st = speechEvent(st, 'user', 'started', rp(), 2000);
    expect(shown(st, rp())).toEqual(['Sure thing.']); // 1 s at 2.7 words/s: two words, though playback covers five
  });
  it('a phantom stop (user partial only) is provisional: the same reply resuming reopens it and is paced from its offset', () => {
    const REP = "That's a good pairing, since ski mornings and an onsen soak fit together. Do you ski?";
    const p1 = () => [turn('u1', 'user'), turn('a1', 'assistant', REP)];
    const at = (st: any, ms: number) => transcriptRows(st, p1(), ms).filter((r) => r.role === 'assistant').at(-1)!.text;
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', p1(), 1000);
    st = playbackEvent(st, PB(6, REP), 1050);
    st = addFinal(st, 'assistant', "That's a good pairing since", p1());
    st = speechEvent(st, 'assistant', 'stopped', p1(), 3000);
    st = setPartial(st, 'user', 'Niseko', p1()); // a phantom: no user speech start, no final
    expect(at(st, 3100)).toBe("That's a good pairing, since");
    st = speechEvent(st, 'assistant', 'started', p1(), 5000);
    st = playbackEvent(st, PB(7, 'and an onsen soak fit together. Do you ski?'), 5050);
    expect(at(st, 5100)).toBe("That's a good pairing, since"); // nothing of the suffix spoken yet
    expect(at(st, 6500)).toBe("That's a good pairing, since ski mornings and an onsen soak"); // gap words, then 4 suffix words
    expect(at(st, 30000)).toBe(REP);
  });
  it.each(['user start', 'user final'] as const)('real %s permanently retires a provisional cut', evidence => {
    const REP = 'Sure thing. Hokkaido has deep snow in March. Are you skiing?';
    const p1 = () => [turn('u1', 'user'), turn('a1', 'assistant', REP)];
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', p1(), 1000);
    st = playbackEvent(st, PB(1, REP), 1050);
    st = addFinal(st, 'assistant', 'Sure thing.', p1());
    st = speechEvent(st, 'assistant', 'stopped', p1(), 2000);
    st = setPartial(st, 'user', 'Niseko', p1());
    const cut = shown(st, p1());
    st = evidence === 'user start'
      ? speechEvent(st, 'user', 'started', p1(), 2200)
      : addFinal(st, 'user', 'Actually Furano', p1());
    expect(st.prov).toBeNull();

    const p2 = [...p1(), turn('u2', 'user', 'Actually Furano'), turn('a2', 'assistant', 'Are you booking flights now?')];
    st = speechEvent(st, 'assistant', 'started', p2, 4000);
    st = playbackEvent(st, PB(2, 'Are you booking flights now?'), 4050);
    expect(shown(st, p2)[0]).toBe(cut[0]);
  });
  it('a matching prefix from a later reply cannot reopen an archived cut row', () => {
    const REP = 'Sure thing. Hokkaido has deep snow in March. Are you skiing?';
    const p1 = [turn('u1', 'user'), turn('a1', 'assistant', REP)];
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', p1, 1000);
    st = playbackEvent(st, PB(1, REP), 1050);
    st = addFinal(st, 'assistant', 'Sure thing.', p1);
    st = speechEvent(st, 'assistant', 'stopped', p1, 2000);
    st = setPartial(st, 'user', 'Niseko', p1);
    const cut = shown(st, p1)[0];
    const p2 = [...p1, turn('u2', 'user', 'Tell me more'), turn('a2', 'assistant', 'Are you booking flights now?')];
    st = syncCaptionPath(st, p2);
    expect(st.prov).toBeNull();
    st = speechEvent(st, 'assistant', 'started', p2, 4000);
    st = playbackEvent(st, PB(2, 'Are you booking flights now?'), 4050);
    st = addFinal(st, 'assistant', 'Are you booking flights now?', p2);
    expect(shown(st, p2, 30000)[0]).toBe(cut);
  });
  it('a replay overlapping the cut prefix advances without duplicating or freezing it', () => {
    const REP = 'Sure thing. Hokkaido has deep snow in March. Are you skiing?';
    const path = [turn('u1', 'user'), turn('a1', 'assistant', REP)];
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', path, 1000);
    st = playbackEvent(st, PB(1, REP), 1050);
    st = addFinal(st, 'assistant', 'Sure thing. Hokkaido has deep snow in March. Are you', path);
    st = speechEvent(st, 'assistant', 'stopped', path, 3000);
    st = setPartial(st, 'user', 'Niseko', path);
    const cut = shown(st, path)[0];
    st = speechEvent(st, 'assistant', 'started', path, 5000);
    st = playbackEvent(st, PB(2, 'Are you skiing?'), 5050);
    st = addFinal(st, 'assistant', 'Are you skiing?', path);
    st = speechEvent(st, 'assistant', 'stopped', path, 7000);
    expect(shown(st, path)[0]).toBe(REP);
    expect(shown(st, path)[0].startsWith(cut)).toBe(true);
  });
  it('a real interruption stays cut when a different reply follows', () => {
    const REP = 'Sure thing. Hokkaido has deep snow in March.';
    const p1 = () => [turn('u1', 'user'), turn('a1', 'assistant', REP)];
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', p1(), 1000);
    st = playbackEvent(st, PB(1, REP), 1050);
    st = speechEvent(st, 'user', 'started', p1(), 2000); // the user took the floor
    st = speechEvent(st, 'assistant', 'started', p1(), 4000);
    st = playbackEvent(st, PB(2, 'Hokkaido has deep snow in March.'), 4050);
    expect(transcriptRows(st, p1(), 30000).at(-1)!.text).toBe('Sure thing.');
  });
  it('a leading filler uses up cursor time before the reply starts', () => {
    const REP = 'Sure thing. Hokkaido has deep snow in March.';
    const p1 = () => [turn('u1', 'user'), turn('a1', 'assistant', REP)];
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', p1(), 1000);
    st = playbackEvent(st, PB(1, `Okay, let me see. ${REP}`), 1050);
    // 2 s = 5 spoken words, 4 of them the filler: one reply word
    expect(transcriptRows(st, p1(), 3000).at(-1)!.text).toBe('Sure');
  });
  it('a whole reply in the first playback event is shown paced by time, never ahead of the voice', () => {
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', rp(), 1000);
    st = playbackEvent(st, PB(1, R), 1050);
    const at = (ms: number) => transcriptRows(st, rp(), ms).filter((r) => r.role === 'assistant').map((r) => r.text);
    expect(at(1100)).toEqual([]);
    expect(at(2000)).toEqual(['Sure thing.']); // 2 words
    expect(at(3000)).toEqual(['Sure thing. Hokkaido has deep']); // 5 words
    expect(at(30000)).toEqual([R]);
    st = speechEvent(st, 'assistant', 'stopped', rp(), 3000);
    expect(at(30000)).toEqual(['Sure thing. Hokkaido has deep']); // the cursor stops with the voice
  });
});

describe('flush tags and a disconnect', () => {
  it('assistant transcript text loses flush tags', () => {
    let st: any = voiceOn();
    st = addFinal(st, 'assistant', 'Hi. <flush/> there', []);
    st = setPartial(st, 'assistant', '</flush>more', []);
    expect(st.said.text).toBe('Hi. there');
    expect(st.said.part).toBe('more');
  });
  it('a disconnect never makes unheard replies visible', () => {
    const path = [turn('u1', 'user'), turn('a1', 'assistant', 'Never spoken one.'), turn('u2', 'user'), turn('a2', 'assistant', 'Hokkaido has snow. Skiing is great.')];
    let st: any = voiceOn();
    st = speechEvent(st, 'assistant', 'started', path);
    st = addFinal(st, 'assistant', 'Hokkaido has snow.', path);
    st = setGate(st, false, path);
    expect(shown(st, path)).toEqual(['Hokkaido has snow.']);
  });
  it('typed replies and the greeting still work', () => {
    let st: any = voiceOn();
    st = addFinal(st, 'assistant', 'Hi.', []);
    st = setGate(st, false, []);
    expect(captionRows(st, [])).toEqual([{ role: 'assistant', text: 'Hi.', live: false }]);
    expect(shown(openReplies(voiceOn()), reply())).toEqual([REPLY]);
  });
});

describe('transcriptRows', () => {
  it('a continuation joins the recorded trailing user turn as one row', () => {
    const path = [{ id: 'u1', role: 'user', text: 'A small ryokan' }];
    const st = setPartial(setGate(emptyCaptions(), true), 'user', 'and ski most mornings', path);
    expect(transcriptRows(st, path).filter((r: any) => r.role === 'user').map((r: any) => r.text)).toEqual(['A small ryokan and ski most mornings']);
  });
  it('a caption that restates the recorded turn replaces it instead of repeating it', () => {
    const path = [turn('u1', 'user', 'A small ryokan')];
    const st = setPartial(emptyCaptions(), 'user', 'A small ryokan and ski', path);
    expect(transcriptRows(st, path).map((r: any) => r.text)).toEqual(['A small ryokan and ski']);
  });
  it('a genuine new user turn after a reply stays a separate row', () => {
    const path = [turn('u1', 'user', 'Hello'), turn('a1', 'assistant', 'Hi')];
    const st = setPartial(emptyCaptions(), 'user', 'Next question', path);
    expect(transcriptRows(st, path).map((r: any) => r.text)).toEqual(['Hello', 'Hi', 'Next question']);
  });
  it('a hidden unheard reply does not let a new utterance join the earlier user turn', () => {
    const path = [turn('u1', 'user', 'Hello'), turn('a1', 'assistant', 'Never spoken.')];
    const st = setPartial(voiceOn(), 'user', 'Wait', path);
    expect(transcriptRows(st, path).map((r: any) => r.text)).toEqual(['Hello', 'Wait']);
  });
  it('recorded path turns are never merged with each other', () => {
    const path = [turn('u1', 'user', 'One'), turn('u2', 'user', 'Two')];
    expect(transcriptRows(emptyCaptions(), path).map((r: any) => r.text)).toEqual(['One', 'Two']);
  });
  it('keeps the greeting first and marks corrections', () => {
    let st: any = voiceOn();
    st = addFinal(st, 'assistant', 'Hi.', []);
    st = speechEvent(st, 'user', 'started', []); // the greeting is kept once the user takes the floor
    const path = [{ id: 'u1', role: 'user', text: 'Japan', kind: 'correction' }];
    expect(transcriptRows(st, path)).toEqual([
      { role: 'assistant', text: 'Hi.', corrected: false, live: false },
      { role: 'user', text: 'Japan', corrected: true, live: false },
    ]);
  });
});
