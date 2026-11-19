import { describe, expect, it } from 'vitest';
import { fallbackCount, fillerRate, speculationRate, stageStats } from '../src/latencyStats.js';
import type { TurnTrace } from '../src/trace.js';

const traces: TurnTrace[] = [
  { finalAt: 1000, routeMs: 100, routeBy: 'jev', firstChunkAt: 1300, firstSentenceAt: 1500 },
  { finalAt: 2000, routeMs: 200, routeBy: 'jev', firstChunkAt: 2400, firstSentenceAt: 2800, fillerAt: 2250, filler: true },
  { finalAt: 3000, routeMs: 300, routeBy: 'fallback', firstChunkAt: 3500, firstSentenceAt: 4000 },
  // no finalAt: falls back to llmRequestAt
  { llmRequestAt: 5000, routeMs: 400, routeBy: 'jev', firstChunkAt: 5600, firstSentenceAt: 6200 },
  { finalAt: 7000, routeMs: 500, routeBy: 'jev', firstChunkAt: 7700, firstSentenceAt: 8500 },
  // incomplete: nothing to measure
  { finalAt: 9000 },
];

describe('stageStats', () => {
  const s = stageStats(traces);

  it('computes nearest-rank p50/p90 for route', () => {
    expect(s.route).toEqual({ p50: 300, p90: 500, n: 5 });
  });

  it('measures end of speech to first real sentence, using llmRequestAt when finalAt is missing', () => {
    // 500, 800, 1000, 1200, 1500
    expect(s.endToFirstSentence).toEqual({ p50: 1000, p90: 1500, n: 5 });
  });

  it('measures end of speech to first chunk', () => {
    // 300, 400, 500, 600, 700
    expect(s.endToFirstByte).toEqual({ p50: 500, p90: 700, n: 5 });
  });

  it('measures end of speech to first audio, counting a filler as audio', () => {
    // 500, 250 (filler), 1000, 1200, 1500
    expect(s.endToFirstAudio).toEqual({ p50: 1000, p90: 1500, n: 5 });
  });

  it('skips traces missing a field and reports zeros for an empty stage', () => {
    const e = stageStats([{ finalAt: 1 }]);
    expect(e.route).toEqual({ p50: 0, p90: 0, n: 0 });
    expect(e.endToFirstAudio.n).toBe(0);
  });
});

describe('fallbackCount', () => {
  it('counts router fallbacks out of traces that were routed', () => {
    expect(fallbackCount(traces)).toEqual({ n: 1, total: 5 });
  });
});

describe('speculationRate', () => {
  it('counts hits among routed turns that had a stable partial', () => {
    const t: TurnTrace[] = [
      { routeBy: 'jev', stablePartialAt: 1, speculationHit: true },
      { routeBy: 'jev', stablePartialAt: 2, speculationHit: false },
      { routeBy: 'jev', stablePartialAt: 3 },
      { routeBy: 'jev' }, // no stable partial: not eligible
      { stablePartialAt: 4, speculationHit: true }, // never routed: not eligible
    ];
    expect(speculationRate(t)).toEqual({ hits: 1, eligible: 3, rate: 1 / 3 });
  });

  it('is zero for no eligible turns', () => {
    expect(speculationRate([])).toEqual({ hits: 0, eligible: 0, rate: 0 });
  });
});

describe('fillerRate', () => {
  it('counts turns with a filler among turns that got a reply', () => {
    const t: TurnTrace[] = [
      { firstSentenceAt: 5, filler: true },
      { firstSentenceAt: 6 },
      { fillerAt: 7, filler: true },
      { finalAt: 9 }, // no reply
    ];
    expect(fillerRate(t)).toEqual({ n: 2, total: 3, rate: 2 / 3 });
  });

  it('is zero for no replies', () => {
    expect(fillerRate([])).toEqual({ n: 0, total: 0, rate: 0 });
  });
});
