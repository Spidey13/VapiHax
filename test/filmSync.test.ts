import { describe, it, expect } from 'vitest';
import { fitOffset, parseSilences, speechOnsets, toSessionTime } from '../src/film/sync.js';

describe('parseSilences', () => {
  it('reads ffmpeg silencedetect lines', () => {
    const err = [
      '[silencedetect @ 0000020a] silence_start: 0',
      '[silencedetect @ 0000020a] silence_end: 1.53 | silence_duration: 1.53',
      'size=N/A time=00:00:10.00 bitrate=N/A',
      '[silencedetect @ 0000020a] silence_start: 4.2',
      '[silencedetect @ 0000020a] silence_end: 5.875 | silence_duration: 1.675',
      '[silencedetect @ 0000020a] silence_start: 9.5',
    ].join('\n');
    expect(parseSilences(err, 10)).toEqual([
      { start: 0, end: 1.53 },
      { start: 4.2, end: 5.875 },
      { start: 9.5, end: 10 },
    ]);
  });
});

describe('speechOnsets', () => {
  it('is every silence end before the file ends, plus 0 when sound starts at once', () => {
    expect(speechOnsets([{ start: 0, end: 1.5 }, { start: 4, end: 6 }, { start: 9, end: 10 }], 10)).toEqual([1.5, 6]);
    expect(speechOnsets([{ start: 2, end: 3 }], 10)).toEqual([0, 3]);
  });
});

describe('fitOffset', () => {
  it('recovers a known offset from jittered onsets with spurious ones mixed in', () => {
    const events = [0.8, 6.1, 13.4, 20.2, 29.9, 37.5, 44.0];
    const jitter = [0.04, -0.06, 0.02, 0.08, -0.03, 0.05, -0.02];
    const onsets = events.map((e, i) => e + 3.217 + jitter[i]);
    onsets.push(11.0, 26.42); // a cough, a door
    onsets.sort((a, b) => a - b);
    const r = fitOffset(events, onsets);
    expect(r.matched).toBe(7);
    expect(r.offset).toBeCloseTo(3.237, 1);
    expect(Math.max(...r.residuals.map(Math.abs))).toBeLessThan(0.3);
  });

  it('matches few events when the lists are unrelated', () => {
    const r = fitOffset([1, 2.7, 9.1, 15.3, 22.8, 30.2], [5.55, 18.1, 40.9]);
    expect(r.matched).toBeLessThan(5);
  });
});

describe('toSessionTime', () => {
  it('moves every event to seconds of the recording', () => {
    const log = { version: 1, startedAt: 5, events: [{ t: 1500, type: 'end' }, { t: 0, type: 'hold', on: true }] };
    const s = toSessionTime(log, 2.25);
    expect(s.offset).toBe(2.25);
    expect(s.standIn).toBe(false);
    expect(s.events).toEqual([{ t: 3.75, type: 'end' }, { t: 2.25, type: 'hold', on: true }]);
  });
});
