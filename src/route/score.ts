import type { Op, RouteDecision, RouteInput } from './types.js';

export interface EvalItem { id: string; input: RouteInput; expect: Op['kind']; expectTarget?: string }

export interface Score {
  accuracy: number;
  perKind: Record<string, { precision: number; recall: number; n: number }>;
  confusion: Record<string, Record<string, number>>;
  falseForkRate: number;
  p50Ms: number;
  p90Ms: number;
}

const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/** A switch, compare or merge only counts as right when it lands on the expected branch. */
function isRight(item: EvalItem, op: Op): boolean {
  if (op.kind !== item.expect) return false;
  if (op.kind === 'switch') return op.targetId === item.expectTarget;
  if (op.kind === 'compare' || op.kind === 'merge') return item.expectTarget === undefined ? op.kind === 'compare' : op.otherId === item.expectTarget;
  return true;
}

export function score(rows: { item: EvalItem; got: RouteDecision }[]): Score {
  const confusion: Score['confusion'] = {};
  const expected: Record<string, number> = {};
  const predicted: Record<string, number> = {};
  const right: Record<string, number> = {};
  let correct = 0;
  let falseForks = 0;

  for (const { item, got } of rows) {
    const e = item.expect;
    const p = got.op.kind;
    confusion[e] ??= {};
    confusion[e][p] = (confusion[e][p] ?? 0) + 1;
    expected[e] = (expected[e] ?? 0) + 1;
    predicted[p] = (predicted[p] ?? 0) + 1;
    if (isRight(item, got.op)) {
      correct++;
      right[e] = (right[e] ?? 0) + 1;
    }
    if (p === 'fork' && e !== 'fork') falseForks++;
  }

  const perKind: Score['perKind'] = {};
  for (const k of new Set([...Object.keys(expected), ...Object.keys(predicted)])) {
    perKind[k] = { precision: ratio(right[k] ?? 0, predicted[k] ?? 0), recall: ratio(right[k] ?? 0, expected[k] ?? 0), n: expected[k] ?? 0 };
  }

  const ms = rows.map((r) => r.got.ms).sort((a, b) => a - b);
  return {
    accuracy: ratio(correct, rows.length),
    perKind,
    confusion,
    falseForkRate: ratio(falseForks, predicted.fork ?? 0),
    p50Ms: percentile(ms, 0.5),
    p90Ms: percentile(ms, 0.9),
  };
}
