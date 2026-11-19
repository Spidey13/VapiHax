import fs from 'node:fs';
import path from 'node:path';
import { cacheKey, loadItems, splitOf, writeJsonAtomic } from '../src/route/evalData.js';
import { JevRouter } from '../src/route/jev.js';
import { decide } from '../src/route/policy.js';
import { score, type EvalItem, type Score } from '../src/route/score.js';
import type { RawAnswers, RouteDecision } from '../src/route/types.js';

try { process.loadEnvFile?.(); } catch { /* no .env is fine */ }

const ITEMS = 'eval/router/items.jsonl';
const CACHE = 'eval/router/cache.json';
const REPORTS = 'docs/results/generated';

export type Cache = Record<string, { raw: RawAnswers; ms: number }>;
type Row = { item: EvalItem; got: RouteDecision };

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function renderSection(title: string, s: Score, n: number): string[] {
  const kinds = Object.keys(s.perKind).sort();
  return [
    `## ${title}`,
    '',
    `- n: ${n}`,
    `- accuracy: ${pct(s.accuracy)}`,
    `- falseForkRate: ${pct(s.falseForkRate)}`,
    `- p50: ${s.p50Ms} ms`,
    `- p90: ${s.p90Ms} ms`,
    '',
    '| kind | precision | recall | n |',
    '| --- | --- | --- | --- |',
    ...kinds.map((k) => `| ${k} | ${pct(s.perKind[k].precision)} | ${pct(s.perKind[k].recall)} | ${s.perKind[k].n} |`),
    '',
    'Confusion matrix (rows expected, columns got)',
    '',
    `| expected \\\\ got | ${kinds.join(' | ')} |`,
    `| --- | ${kinds.map(() => '---').join(' | ')} |`,
    ...kinds.map((e) => `| ${e} | ${kinds.map((g) => s.confusion[e]?.[g] ?? 0).join(' | ')} |`),
    '',
  ];
}

export function renderReport(rows: Row[]): string {
  const tune = rows.filter((r) => splitOf(r.item.id) === 'tune');
  const heldout = rows.filter((r) => splitOf(r.item.id) === 'heldout');
  return [
    '# Router evaluation',
    '',
    ...renderSection('Overall', score(rows), rows.length),
    ...renderSection('Tune split', score(tune), tune.length),
    ...renderSection('Held-out split', score(heldout), heldout.length),
  ].join('\n');
}

function readCache(): Cache {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')) as Cache; } catch { return {}; }
}

async function main(): Promise<void> {
  const offline = process.argv.includes('--offline');
  let items: EvalItem[];
  try {
    items = loadItems(ITEMS);
  } catch (e) {
    console.error(`cannot load ${ITEMS}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  const cache = readCache();
  if (offline) {
    const missing = items.filter((i) => !cache[cacheKey(i)]).map((i) => i.id);
    if (missing.length > 0) {
      console.error(`--offline: ${missing.length} of ${items.length} items are not in ${CACHE}: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}`);
      console.error('Run `npm run eval:router` once (billed) to fill the cache.');
      process.exit(1);
    }
  }

  const router = offline ? null : new JevRouter();
  const rows: Row[] = [];
  let hits = 0;
  let fallbacks = 0;
  let fresh = 0;
  const flush = (): void => { if (!offline && fresh > 0) writeJsonAtomic(CACHE, cache); };
  try {
    for (const item of items) {
      const key = cacheKey(item);
      const cached = cache[key];
      let got: RouteDecision;
      if (cached) {
        hits++;
        const d = decide(cached.raw, item.input);
        got = { ...d, by: 'jev', ms: cached.ms, raw: cached.raw };
      } else {
        got = await router!.route(item.input);
        if (got.by === 'jev' && got.raw) {
          cache[key] = { raw: got.raw, ms: got.ms };
          if (++fresh % 10 === 0) flush();
        } else {
          fallbacks++; // fallbacks are never cached, so a rerun retries them
        }
      }
      rows.push({ item, got });
      const right = score([{ item, got }]).accuracy === 1;
      console.log(`${right ? 'ok  ' : 'MISS'} ${item.id} [${splitOf(item.id)}] expected ${item.expect} got ${got.op.kind} (${got.by}${cached ? ', cached' : ''}, ${got.ms} ms)`);
    }
  } finally {
    flush(); // paid answers survive a crash
  }
  if (fallbacks > 0) console.warn(`warning: ${fallbacks} item(s) fell back and were not cached; rerun to retry them`);

  const report = renderReport(rows);
  console.log(`\ncache hits: ${hits}/${items.length}\n\n${report}`);
  fs.mkdirSync(REPORTS, { recursive: true });
  const file = path.join(REPORTS, `${new Date().toISOString().replace(/[:.]/g, '-')}-router.md`);
  fs.writeFileSync(file, report, 'utf8');
  console.log(`report written to ${file}`);
}

await main();
