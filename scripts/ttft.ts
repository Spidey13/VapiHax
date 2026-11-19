import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { replyParams } from '../src/reply/responder.js';
import { summarize } from '../src/latencyStats.js';

try { process.loadEnvFile?.(); } catch { /* no .env is fine */ }

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const RUNS = 10;
const OUT = 'docs/results/generated/claude-ttft.md';

const CONTEXT = {
  messages: [
    { role: 'user' as const, content: 'I want to plan a small weekend workshop on sourdough for beginners.' },
    { role: 'assistant' as const, content: 'Nice. Do you want to start with the schedule, or who it is for?' },
    { role: 'user' as const, content: 'Let us start with the schedule. Maybe two sessions, but I am not sure how long each should be.' },
  ],
  notes: [],
};

interface Row {
  model: string;
  ttft: ReturnType<typeof summarize>;
  stopReasons: Record<string, number>;
  emptyOrMax: number;
  runs: number;
  errors: number;
}

async function measure(client: Anthropic, model: string): Promise<Row> {
  const ttfts: number[] = [];
  const stopReasons: Record<string, number> = {};
  let emptyOrMax = 0;
  let errors = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    let first: number | undefined;
    let text = '';
    try {
      const stream = client.beta.messages.stream(replyParams({ context: CONTEXT }, model));
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          first ??= performance.now() - t0;
          text += ev.delta.text;
        }
      }
      const final = await stream.finalMessage();
      const reason = final.stop_reason ?? 'unknown';
      stopReasons[reason] = (stopReasons[reason] ?? 0) + 1;
      if (text.trim() === '' || reason === 'max_tokens') emptyOrMax++;
    } catch (e) {
      errors++;
      console.error(`${model} run ${i + 1} failed: ${e instanceof Error ? e.message : 'error'}`);
    }
    if (first !== undefined) ttfts.push(first);
  }
  return { model, ttft: summarize(ttfts), stopReasons, emptyOrMax, runs: RUNS, errors };
}

export function renderTable(rows: Row[]): string {
  return [
    '| model | p50 ms | p90 ms | n | stop reasons | empty or max_tokens | errors |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => {
      const stops = Object.entries(r.stopReasons).map(([k, v]) => `${k}: ${v}`).join(', ') || '-';
      const c = (k: 'p50' | 'p90') => (r.ttft.n === 0 ? '-' : String(Math.round(r.ttft[k])));
      return `| ${r.model} | ${c('p50')} | ${c('p90')} | ${r.ttft.n} | ${stops} | ${r.emptyOrMax}/${r.runs} | ${r.errors} |`;
    }),
  ].join('\n');
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Set it in the environment or .env; this run is billed, so no request was made.');
    process.exit(1);
  }
  const client = new Anthropic();
  const rows: Row[] = [];
  for (const m of MODELS) rows.push(await measure(client, m));
  const table = renderTable(rows);
  console.log(table);
  const section = [
    `## Claude time-to-first-token (measured ${new Date().toISOString().slice(0, 10)})`,
    '',
    `Uses the current replyParams configuration on a fixed three-turn context, with ${RUNS} runs per model. Measures time to first text delta.`,
    '',
    table,
    '',
  ].join('\n');
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '# Latency measurements\n\n';
  const re = /## Claude time-to-first-token[^\n]*\n[\s\S]*?(?=\n## |$)/;
  const next = re.test(prev) ? prev.replace(re, () => section) : `${prev.trimEnd()}\n\n${section}`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, next);
  console.log(`\nWrote ${OUT}`);
}

if (process.argv[1]?.endsWith('ttft.ts')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : 'ttft failed');
    process.exit(1);
  });
}
