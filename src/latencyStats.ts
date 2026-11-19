import type { TurnTrace } from './trace.js';

export interface Stat { p50: number; p90: number; n: number }
export type Stage = 'route' | 'endToFirstSentence' | 'endToFirstByte' | 'endToFirstAudio';

/** Nearest-rank percentile of an ascending list; 0 for an empty list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function summarize(values: number[]): Stat {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), n: sorted.length };
}

const start = (t: TurnTrace): number | undefined => t.finalAt ?? t.llmRequestAt;

function since(t: TurnTrace, at: number | undefined): number | undefined {
  const from = start(t);
  return from === undefined || at === undefined ? undefined : at - from;
}

/** Stage latencies in ms. Traces missing a field are skipped for that stage. */
export function stageStats(traces: TurnTrace[]): Record<Stage, Stat> {
  const pick = (f: (t: TurnTrace) => number | undefined): number[] =>
    traces.map(f).filter((v): v is number => v !== undefined);
  return {
    route: summarize(pick((t) => t.routeMs)),
    // First real content: a filler does not count.
    endToFirstSentence: summarize(pick((t) => since(t, t.firstSentenceAt))),
    endToFirstByte: summarize(pick((t) => since(t, t.firstChunkAt))),
    // First thing the caller hears: a filler counts.
    endToFirstAudio: summarize(
      pick((t) => {
        const times = [t.fillerAt, t.firstSentenceAt].filter((v): v is number => v !== undefined);
        return times.length ? since(t, Math.min(...times)) : undefined;
      }),
    ),
  };
}

/** How many routed turns used the fallback (Jev timed out or errored). */
export function fallbackCount(traces: TurnTrace[]): { n: number; total: number } {
  const routed = traces.filter((t) => t.routeBy !== undefined);
  return { n: routed.filter((t) => t.routeBy === 'fallback').length, total: routed.length };
}

/** Share of routed turns with a stable partial whose speculated routing was reused at the final. */
export function speculationRate(traces: TurnTrace[]): { hits: number; eligible: number; rate: number } {
  const eligible = traces.filter((t) => t.routeBy !== undefined && t.stablePartialAt !== undefined);
  const hits = eligible.filter((t) => t.speculationHit === true).length;
  return { hits, eligible: eligible.length, rate: eligible.length ? hits / eligible.length : 0 };
}

/** Share of turns that got a reply (a filler or a real sentence) where a filler was spoken. */
export function fillerRate(traces: TurnTrace[]): { n: number; total: number; rate: number } {
  const replied = traces.filter((t) => t.firstSentenceAt !== undefined || t.fillerAt !== undefined);
  const n = replied.filter((t) => t.filler === true || t.fillerAt !== undefined).length;
  return { n, total: replied.length, rate: replied.length ? n / replied.length : 0 };
}
