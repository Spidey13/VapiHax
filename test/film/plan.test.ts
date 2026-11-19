import { describe, it, expect } from 'vitest';
import { buildFilm, groupWords, readTime, LEAD, MOVE } from '../../film/lib/plan.js';

const sp = (t: number, role: string, status: string) => ({ t, type: 'speech', role, status });
const play = (t: number, kind: string, revision = 1) => ({ t, type: 'play', phase: 'start', kind, revision });
const session = {
  events: [
    sp(3, 'user', 'started'), sp(7, 'user', 'stopped'), sp(8.4, 'assistant', 'started'), sp(12, 'assistant', 'stopped'),
    play(8.0, 'fork', 4),
    sp(20, 'user', 'started'), sp(22, 'user', 'stopped'), sp(23.5, 'assistant', 'started'), sp(27, 'assistant', 'stopped'),
    play(23.0, 'switch', 6), play(24.5, 'compare', 7),
  ],
};
const cut = {
  opener: { src: [5, 14] as [number, number], zoom: { at: 7.5 } },
  title: 2,
  beats: [
    { id: 'plan', src: [2.5, 13] as [number, number], card: { title: 'Forked.', line: 'The dinner plan is still there.' } },
    { id: 'back', src: [19, 28] as [number, number], card: { title: 'Back to the dinner.', line: 'Found by description, not by name.' } },
  ],
  numbers: 4,
  endCard: 3,
};

describe('buildFilm', () => {
  const f = buildFilm(session, cut);

  it('lays the sections end to end', () => {
    expect(f.opener!.dur).toBe(9);
    expect(f.title.at).toBe(9);
    expect(f.segments.map((s: any) => s.at)).toEqual([11, 21.5]);
    expect(f.numbers.at).toBe(30.5);
    expect(f.duration).toBe(37.5);
  });

  it('maps session time to film time and back', () => {
    expect(f.toFilm(8)).toBeCloseTo(16.5);
    expect(f.toFilm(16)).toBeNull(); // cut
    expect(f.srcAt(16.5)).toBeCloseTo(8);
    expect(f.srcAt(0)).toBe(2.5);
    expect(f.srcAt(99)).toBe(28);
  });

  it('arrives at the map just before each animation starts', () => {
    const v = f.visits[0];
    expect(v.arrive).toBeCloseTo(16.5 - LEAD);
    const shot = f.shots.find((s: any) => s.to === 'map')!;
    expect(shot.at + shot.dur).toBeCloseTo(16.5 - LEAD);
    expect(shot.dur).toBe(MOVE);
  });

  it('shares one visit between animations 1.5 s apart, one text block after the other', () => {
    expect(f.visits.length).toBe(2);
    expect(f.visits[1].plays.map((p: any) => p.kind)).toEqual(['switch', 'compare']);
    expect(f.shots.filter((s: any) => s.to === 'map').length).toBe(2);
  });

  it('holds each text block long enough to read', () => {
    for (const c of f.cards) expect(c.dur + 1e-9).toBeGreaterThanOrEqual(readTime(c.title, c.line));
    expect(f.cards[0].title).toBe('Forked.');
  });

  it('starts wide and pushes in to the words', () => {
    expect(f.shots[0]).toMatchObject({ at: 11, to: 'wide' });
    expect(f.shots[1]).toMatchObject({ to: 'words' });
  });
});

describe('subtitles', () => {
  const words = [
    { text: 'A', start: 8.5, end: 8.7 }, { text: 'barbecue', start: 8.7, end: 9.1 }, { text: 'feels', start: 9.1, end: 9.3 },
    { text: 'more', start: 9.3, end: 9.5 }, { text: 'like', start: 9.5, end: 9.7 }, { text: 'him.', start: 9.7, end: 10.0 },
    { text: 'Who', start: 10.3, end: 10.5 },
  ];
  it('groups up to six words, breaking at a sentence end', () => {
    const g = groupWords(words, session.events);
    expect(g.map((x: any) => x.text)).toEqual(['A barbecue feels more like him.', 'Who']);
    expect(g[0].role).toBe('assistant');
  });
  it('shows only while the camera is away from the transcript', () => {
    const f = buildFilm(session, { ...cut, opener: undefined }, { words });
    const v = f.visits[0];
    for (const s of f.subs) {
      expect(s.at).toBeGreaterThanOrEqual(v.moveStart);
      expect(s.at + s.dur).toBeLessThanOrEqual(v.back);
    }
    expect(f.subs.length).toBeGreaterThan(0);
  });
});
