import fs from 'node:fs';
import path from 'node:path';
import { cacheKey, loadItems, splitOf } from '../src/route/evalData.js';
import { ROUTER_SPEC_VERSION } from '../src/route/jev.js';
import { decide, THRESHOLDS, type Thresholds } from '../src/route/policy.js';
import { score, type EvalItem } from '../src/route/score.js';
import { FALSE_FORK_LIMIT, GRID, beats, tuneBoth, type TuneRow } from '../src/route/tune.js';
import type { RawAnswers, RouteDecision } from '../src/route/types.js';

const ITEMS = 'eval/router/items.jsonl';
const CACHE = 'eval/router/cache.json';
const OUT = 'docs/results/generated/router-tuned.md';

type Cache = Record<string, { raw: RawAnswers; ms: number }>;
type Row = TuneRow & { ms: number };

/** First run on these same 156 items, before the takes-up question was reworded (kept so the report cannot forget it). */
const FIRST_RUN = { file: '../evidence/router-before-question-revision.md', heldoutAccuracy: '86.8%', heldoutFalseFork: '36.4%' };

/** Wilson score interval, z = 1.96. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const tkey = (t: Thresholds): string => `intent ${t.intent}, detailHigh ${t.detailHigh}, target ${t.target}, takesUp ${t.takesUp}`;

function decided(rows: Row[], t: Thresholds): { item: EvalItem; got: RouteDecision }[] {
  return rows.map(({ item, raw, ms }) => ({ item, got: { ...decide(raw, item.input, t), by: 'jev' as const, ms, raw } }));
}

function ruleOf(reason: string): string {
  if (reason.startsWith('takes up suggestion')) return 'takesUpSuggestion';
  if (reason.startsWith('new direction')) return 'newDirection intent';
  return 'other';
}

function falseForks(title: string, rows: Row[], t: Thresholds): string[] {
  const hits = decided(rows, t).filter(({ item, got }) => got.op.kind === 'fork' && item.expect !== 'fork');
  return [
    `### ${title} (${hits.length} false forks)`,
    '',
    ...(hits.length === 0 ? ['None.', ''] : [
      '| item | expected | rule | reason |',
      '| --- | --- | --- | --- |',
      ...hits.map(({ item, got }) => `| ${item.id} | ${item.expect} | ${ruleOf(got.reason)} | ${got.reason} |`),
      '',
    ]),
  ];
}

function section(title: string, rows: Row[], t: Thresholds): string[] {
  const s = score(decided(rows, t));
  const kinds = Object.keys(s.perKind).sort();
  const cm = (e: string, g: string): number => s.confusion[e]?.[g] ?? 0;
  const dec = decided(rows, t);
  const correct = Math.round(s.accuracy * rows.length);
  const predictedForks = dec.filter((r) => r.got.op.kind === 'fork').length;
  const falseCount = dec.filter((r) => r.got.op.kind === 'fork' && r.item.expect !== 'fork').length;
  const [lo, hi] = wilson(correct, rows.length);
  const ffUpper = predictedForks === 0 ? null : falseCount === 0 ? Math.min(1, 3 / predictedForks) : wilson(falseCount, predictedForks)[1];
  return [
    `## ${title}`,
    '',
    `- n: ${rows.length}`,
    `- accuracy: ${pct(s.accuracy)}`,
    `- accuracy Wilson 95% interval: ${pct(lo)} to ${pct(hi)} (${correct} of ${rows.length})`,
    `- false-fork rate: ${pct(s.falseForkRate)} (${falseCount} false of ${predictedForks} predicted forks); upper 95% bound ${ffUpper === null ? 'n/a (no predicted forks)' : pct(ffUpper) + (falseCount === 0 ? ` (rule of three; exact one-sided Clopper-Pearson bound ${pct(1 - Math.pow(0.05, 1 / predictedForks))})` : ' (Wilson)')}`,
    `- router latency from cached timings: p50 ${s.p50Ms} ms, p90 ${s.p90Ms} ms`,
    '',
    '| kind | precision | recall | n | note |',
    '| --- | --- | --- | --- | --- |',
    ...kinds.map((k) => `| ${k} | ${pct(s.perKind[k].precision)} | ${pct(s.perKind[k].recall)} | ${s.perKind[k].n} | ${s.perKind[k].n < 5 ? 'n < 5: indicative only' : ''} |`),
    '',
    'Correction vs new direction (rows expected, columns got; `correct` is the correction op, `fork` the new-direction op):',
    '',
    '| expected / got | correct | fork |',
    '| --- | --- | --- |',
    `| correct | ${cm('correct', 'correct')} | ${cm('correct', 'fork')} |`,
    `| fork | ${cm('fork', 'correct')} | ${cm('fork', 'fork')} |`,
    '',
    'Full confusion matrix (rows expected, columns got):',
    '',
    `| expected / got | ${kinds.join(' | ')} |`,
    `| --- | ${kinds.map(() => '---').join(' | ')} |`,
    ...kinds.map((e) => `| ${e} | ${kinds.map((g) => cm(e, g)).join(' | ')} |`),
    '',
  ];
}

function main(): void {
  const items = loadItems(ITEMS);
  let cache: Cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) as Cache; } catch (e) {
    console.error(`cannot read ${CACHE}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  const missing = items.filter((i) => !cache[cacheKey(i)]).map((i) => i.id);
  if (missing.length > 0) {
    console.error(`${missing.length} of ${items.length} items are missing from ${CACHE} (or stale): ${missing.join(', ')}`);
    console.error('Run `npm run eval:router` (billed) to fill the cache, then rerun.');
    process.exit(1);
  }
  const rows: Row[] = items.map((item) => ({ item, raw: cache[cacheKey(item)].raw, ms: cache[cacheKey(item)].ms }));
  const tuneRows = rows.filter((r) => splitOf(r.item.id) === 'tune');
  const heldRows = rows.filter((r) => splitOf(r.item.id) === 'heldout');

  const both = tuneBoth(tuneRows, GRID, { takesUp: [0.7, 0.8, 0.9] });
  const best = both.chosen;
  const chosen: Thresholds = best ?? THRESHOLDS;

  const gridTable = (title: string, table: ReturnType<typeof tuneBoth>['plan']['table']): string[] => {
    const qualifying = table.filter((p) => p.falseForkRate <= FALSE_FORK_LIMIT);
    const ranked = [...table].sort((a, b) => Number(b.falseForkRate <= FALSE_FORK_LIMIT) - Number(a.falseForkRate <= FALSE_FORK_LIMIT) || (beats(a, b) ? -1 : beats(b, a) ? 1 : 0));
    return [
      `## ${title} (tune split, top 10 of ${table.length})`,
      '',
      qualifying.length > 0 ? `${qualifying.length} of ${table.length} points met the false-fork limit of ${FALSE_FORK_LIMIT}.` : `No point met the false-fork limit of ${FALSE_FORK_LIMIT} (0 of ${table.length}).`,
      '',
      '| rank | intent | detailHigh | target | takesUp | accuracy | false-fork rate | meets limit |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...ranked.slice(0, 10).map((p, i) => `| ${i + 1} | ${p.thresholds.intent} | ${p.thresholds.detailHigh} | ${p.thresholds.target} | ${p.thresholds.takesUp} | ${pct(p.accuracy)} | ${pct(p.falseForkRate)} | ${p.falseForkRate <= FALSE_FORK_LIMIT ? 'yes' : 'no'} |`),
      '',
    ];
  };

  function gridResult(): string[] {
    const src = both.source === 'extended' ? both.extended : both.plan;
    const q = src.table.filter((p) => p.falseForkRate <= FALSE_FORK_LIMIT);
    const lines = [`- grid result (${both.source === 'none' ? 'plan' : both.source} grid): ${q.length} of ${src.table.length} points qualified on the tune split (n ${tuneRows.length}).`];
    if (q.length === src.table.length) lines.push('- the false-fork limit was not binding: every grid point qualified.');
    const accs = [...new Set(q.map((p) => p.accuracy))].sort((a, b) => b - a);
    if (accs.length >= 2) {
      const diff = Math.round((accs[0] - accs[1]) * tuneRows.length);
      lines.push(`- margin: the best qualifying accuracy beats the next-best distinct accuracy by ${diff} of ${tuneRows.length} items (${pct(accs[0])} vs ${pct(accs[1])}).`);
    } else if (accs.length === 1) lines.push('- margin: every qualifying point has the same accuracy, so the choice rests on the tie-break alone.');
    return lines;
  }

  function falseForkSection(): string[] {
    const count = (rs: Row[]) => decided(rs, chosen).filter(({ item, got }) => got.op.kind === 'fork' && item.expect !== 'fork').length;
    if (count(tuneRows) + count(heldRows) === 0) return ['## False forks', '', 'No false forks on either split at the chosen thresholds.'];
    return [
      '## Where the false forks come from',
      '',
      `Thresholds: ${tkey(chosen)}. The rule is taken from the decision reason: "takesUpSuggestion" means the takes-up-suggestion rule fired, "newDirection intent" means the intent was newDirection or correction with a low detail score.`,
      '',
      ...falseForks('Tune split', tuneRows, chosen),
      ...falseForks('Held-out split', heldRows, chosen),
    ];
  }

  const out = [
    '# Router evaluation (tuned thresholds)',
    '',
    `- date: ${new Date().toLocaleDateString('en-CA')}`,
    `- items: ${items.length} (tune ${tuneRows.length}, held-out ${heldRows.length}); split by a stable hash of id (target 70% / 30%; this set lands at ${Math.round(100 * tuneRows.length / items.length)}% / ${Math.round(100 * heldRows.length / items.length)}%)`,
    `- source: cached Jev answers in ${CACHE}; no network calls (\`npm run tune:router\`)`,
    `- router spec version: ${ROUTER_SPEC_VERSION}`,
    `- objective: maximise accuracy on the tune split subject to false-fork rate <= ${FALSE_FORK_LIMIT}; ties are broken by higher intent, then higher takesUp, then lower detailHigh, then lower target (the order implemented by \`beats\` in src/route/tune.ts)`,
    '- grids: the plan grid (intent, detailHigh, target; takesUp fixed at 0.7) is reported first. The extended grid adds takesUp in {0.7, 0.8, 0.9}, a documented extension of the plan. The chosen thresholds come from the extended grid only if the plan grid has no qualifying point.',
    '',
    '## Method notes',
    '',
    `- The [first run on 156 items](${FIRST_RUN.file}) had ${FIRST_RUN.heldoutAccuracy} held-out accuracy and a ${FIRST_RUN.heldoutFalseFork} false-fork rate. Every false fork came from the takes-up rule. That question was reworded after inspecting errors from both splits, and the cache was re-keyed.`,
    '- The held-out figures below are therefore development results, not a blind test. Thresholds were chosen on the tune split only.',
    '- The chosen intent, detailHigh and target are each the lowest value on their grid, so the optimum may lie below the grid; the grid was not extended downwards.',
    "- The takes-up rule can also fire on the user's own idea, so a reason text of 'takes up suggestion' may appear for a fork the user originated. The outcome is a fork either way.",
    '- Samples are small: see the Wilson intervals and the per-kind n < 5 flags.',
    '',
    '## Chosen thresholds',
    '',
    best
      ? `- ${tkey(best)}, taken from the ${both.source} grid (other thresholds unchanged: detailLow ${THRESHOLDS.detailLow}, ackHigh ${THRESHOLDS.ackHigh})`
      : `- none: no point in either grid met the false-fork limit; scoring the current thresholds (${tkey(THRESHOLDS)})`,
    `- plan grid: ${both.plan.best ? 'a point met the false-fork limit' : 'no point met the false-fork limit'}; extended grid: ${both.extended.best ? 'a point met the false-fork limit' : 'no point met the false-fork limit'}`,
    ...gridResult(),
    '',
    ...section('Held-out split (the reported numbers)', heldRows, chosen),
    ...section('Tune split', tuneRows, chosen),
    ...gridTable('Plan grid', both.plan.table),
    ...gridTable('Extended grid with takesUp', both.extended.table),
    ...falseForkSection(),
  ].join('\n');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out, 'utf8');
  console.log(out);
  console.log(`\nwritten to ${OUT}\nchosen: ${best ? JSON.stringify(best) : 'null'}`);
}

main();
