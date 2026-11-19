import { fallbackCount, fillerRate, speculationRate, stageStats, type Stage, type Stat } from '../src/latencyStats.js';
import type { TurnTrace } from '../src/trace.js';

try { process.loadEnvFile?.(); } catch { /* no .env is fine */ }

export const TARGET_MS = 1200;

const cell = (s: Stat, k: 'p50' | 'p90'): string => (s.n === 0 ? '-' : String(Math.round(s[k])));

export function renderTable(traces: TurnTrace[]): string {
  const stats = stageStats(traces);
  const rows: [Stage, string][] = [
    ['route', 'route (Jev)'],
    ['endToFirstByte', 'end of speech to first chunk'],
    ['endToFirstSentence', 'end of speech to first real sentence'],
    ['endToFirstAudio', 'end of speech to first audio (filler counts)'],
  ];
  const fb = fallbackCount(traces);
  const sp = speculationRate(traces);
  const fr = fillerRate(traces);
  const pct = (r: number): string => `${Math.round(r * 100)}%`;
  return [
    '| stage | p50 ms | p90 ms | n |',
    '| --- | --- | --- | --- |',
    ...rows.map(([k, label]) => `| ${label} | ${cell(stats[k], 'p50')} | ${cell(stats[k], 'p90')} | ${stats[k].n} |`),
    '',
    `Speculation hit rate: ${sp.hits} of ${sp.eligible} routed turns with a stable partial (${sp.eligible ? pct(sp.rate) : '-'}).`,
    `Filler rate: ${fr.n} of ${fr.total} replied turns (${fr.total ? pct(fr.rate) : '-'}).`,
    `Router fallbacks: ${fb.n} of ${fb.total} routed turns. Target: end of speech to first sentence p50 <= ${TARGET_MS} ms.`,
  ].join('\n');
}

const MAX_SESSIONS = 3;

async function fetchTraces(sessionId: string, token: string): Promise<TurnTrace[]> {
  const port = process.env.PORT || '3000';
  const res = await fetch(`http://localhost:${port}/api/sessions/${encodeURIComponent(sessionId)}/trace`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`trace request failed for ${sessionId}: HTTP ${res.status}`);
  return ((await res.json()) as { traces: TurnTrace[] }).traces;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length % 2 !== 0 || args.length > MAX_SESSIONS * 2) {
    console.error(`usage: npm run latency -- <sessionId> <token> [<sessionId> <token> ...] (up to ${MAX_SESSIONS} sessions)`);
    process.exit(1);
  }
  const all: TurnTrace[] = [];
  for (let i = 0; i < args.length; i += 2) all.push(...(await fetchTraces(args[i], args[i + 1])));
  console.log(renderTable(all));
}

if (process.argv[1]?.endsWith('latency.ts')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : 'latency failed');
    process.exit(1);
  });
}
