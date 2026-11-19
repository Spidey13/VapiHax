import { describe, it, expect } from 'vitest';
import { createFilmLog, filmFlag } from '../../public/js/filmLog.js';

function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('filmFlag', () => {
  it('is on only with film=1', () => {
    expect(filmFlag('?film=1')).toBe(true);
    expect(filmFlag('?debug=1&film=1')).toBe(true);
    expect(filmFlag('?debug=1')).toBe(false);
    expect(filmFlag('')).toBe(false);
    expect(filmFlag('?film=0')).toBe(false);
  });
});

describe('createFilmLog', () => {
  it('records nothing when disabled', () => {
    const log = createFilmLog({ enabled: false, now: () => 0, wall: () => 5 });
    log.speech('user', 'started');
    log.transcript('user', true, 'hi');
    log.state({ revision: 1 });
    expect(log.on).toBe(false);
    expect(log.toJSON().events).toEqual([]);
  });

  it('stamps events in ms since the log began, with the wall clock kept once', () => {
    const c = clock(1000);
    const log = createFilmLog({ enabled: true, now: c.now, wall: () => 1794775000000 });
    c.advance(250);
    log.speech('assistant', 'started');
    c.advance(100);
    log.transcript('user', false, 'I am planning');
    log.play('start', 'fork', 7);
    log.playback(3, 'model', 'Sure thing.');
    log.hold(true);
    log.end();
    log.share({ map: null });
    const j = log.toJSON();
    expect(j.version).toBe(1);
    expect(j.startedAt).toBe(1794775000000);
    expect(j.events).toEqual([
      { t: 250, type: 'speech', role: 'assistant', status: 'started' },
      { t: 350, type: 'transcript', role: 'user', final: false, text: 'I am planning' },
      { t: 350, type: 'play', phase: 'start', kind: 'fork', revision: 7 },
      { t: 350, type: 'playback', turn: 3, source: 'model', text: 'Sure thing.' },
      { t: 350, type: 'hold', on: true },
      { t: 350, type: 'end' },
      { t: 350, type: 'share', data: { map: null } },
    ]);
  });

  it('stores a state revision once, as a copy', () => {
    const c = clock();
    const log = createFilmLog({ enabled: true, now: c.now, wall: () => 0 });
    const s = { revision: 3, sessionId: 'x', sheets: {} };
    log.state(s);
    log.state({ ...s });
    s.revision = 99; // later mutation must not leak into the log
    log.state({ revision: 4 });
    const states = log.toJSON().events.filter((e: any) => e.type === 'state');
    expect(states.map((e: any) => e.state.revision)).toEqual([3, 4]);
  });
});
