import { decide, THRESHOLDS, type Thresholds } from './policy.js';
import { score, type EvalItem } from './score.js';
import type { RawAnswers } from './types.js';

export interface TuneRow { item: EvalItem; raw: RawAnswers }
export interface TuneGrid { intent: number[]; detailHigh: number[]; target: number[]; takesUp?: number[] }
export interface TunePoint { thresholds: Thresholds; accuracy: number; falseForkRate: number }

export const FALSE_FORK_LIMIT = 0.1;

export const GRID: TuneGrid = { intent: [0.6, 0.65, 0.7, 0.75, 0.8], detailHigh: [0.6, 0.7, 0.8], target: [0.5, 0.6, 0.7] };

/** Score cached raw answers under the given thresholds. Latency is irrelevant here. */
export function scoreAt(rows: TuneRow[], thresholds: Thresholds) {
  return score(rows.map(({ item, raw }) => ({ item, got: { ...decide(raw, item.input, thresholds), by: 'jev' as const, ms: 0, raw } })));
}

/** Explicit tie-break: accuracy, then higher intent, higher takesUp, lower detailHigh, lower target. */
export function beats(p: TunePoint, q: TunePoint): boolean {
  const a = p.thresholds;
  const b = q.thresholds;
  if (p.accuracy !== q.accuracy) return p.accuracy > q.accuracy;
  if (a.intent !== b.intent) return a.intent > b.intent;
  if (a.takesUp !== b.takesUp) return a.takesUp > b.takesUp;
  if (a.detailHigh !== b.detailHigh) return a.detailHigh < b.detailHigh;
  return a.target < b.target;
}

/** Best accuracy with falseForkRate <= 0.10; ties follow `beats` above. */
export function tune(rows: TuneRow[], grid: TuneGrid = GRID): { best: Thresholds | null; table: TunePoint[] } {
  const table: TunePoint[] = [];
  for (const intent of grid.intent) for (const detailHigh of grid.detailHigh) for (const target of grid.target) for (const takesUp of grid.takesUp ?? [THRESHOLDS.takesUp]) {
    const thresholds: Thresholds = { ...THRESHOLDS, intent, detailHigh, target, takesUp };
    const s = scoreAt(rows, thresholds);
    table.push({ thresholds, accuracy: s.accuracy, falseForkRate: s.falseForkRate });
  }
  let best: TunePoint | null = null;
  for (const p of table) {
    if (p.falseForkRate > FALSE_FORK_LIMIT) continue;
    if (best === null || beats(p, best)) best = p;
  }
  return { best: best?.thresholds ?? null, table };
}

export interface TuneBoth {
  plan: ReturnType<typeof tune>;
  extended: ReturnType<typeof tune>;
  chosen: Thresholds | null;
  source: 'plan' | 'extended' | 'none';
}

/** The plan grid (takesUp fixed) wins when it qualifies; otherwise the grid extended with takesUp. */
export function tuneBoth(rows: TuneRow[], grid: TuneGrid = GRID, extra: { takesUp: number[] } = { takesUp: [0.7, 0.8, 0.9] }): TuneBoth {
  const plan = tune(rows, { ...grid, takesUp: undefined });
  const extended = tune(rows, { ...grid, takesUp: extra.takesUp });
  if (plan.best) return { plan, extended, chosen: plan.best, source: 'plan' };
  if (extended.best) return { plan, extended, chosen: extended.best, source: 'extended' };
  return { plan, extended, chosen: null, source: 'none' };
}
