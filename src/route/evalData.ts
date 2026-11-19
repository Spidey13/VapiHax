import fs from 'node:fs';
import path from 'node:path';
import { ROUTER_SPEC_VERSION } from './jev.js';
import type { EvalItem } from './score.js';
import type { Op } from './types.js';

const KINDS: readonly Op['kind'][] = ['continue', 'fork', 'correct', 'switch', 'ask-which', 'park', 'scratch', 'recap', 'compare', 'merge', 'only-one-thread', 'ask-merge'];

/** 32-bit FNV-1a over the UTF-16 code units of `s`. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function splitOf(id: string): 'tune' | 'heldout' {
  return fnv1a(id) % 10 < 7 ? 'tune' : 'heldout';
}

/** Includes the router spec version, so a reworded question never serves stale cached answers. */
export function cacheKey(item: EvalItem, specVersion: string = ROUTER_SPEC_VERSION): string {
  return `${item.id}:${fnv1a(JSON.stringify(item.input)).toString(16).padStart(8, '0')}:${specVersion}`;
}

function validate(raw: unknown, seen: Set<string>): EvalItem {
  const r = raw as Partial<EvalItem> | null;
  const id = typeof r?.id === 'string' && r.id ? r.id : '?';
  const fail = (msg: string): never => { throw new Error(`item ${id}: ${msg}`); };
  if (!r || typeof r !== 'object' || id === '?') return fail('missing id');
  if (seen.has(id)) fail('duplicate id');
  seen.add(id);
  const input = r.input;
  if (!input || typeof input.utterance !== 'string' || !input.current || typeof input.current.id !== 'string' || !Array.isArray(input.others)) fail('malformed input');
  if (!KINDS.includes(r.expect as Op['kind'])) fail(`unknown expect kind ${JSON.stringify(r.expect)}`);
  if ((r.expect === 'switch' || r.expect === 'merge') && !r.expectTarget) fail(`a ${r.expect} item needs an expectTarget`);
  if (r.expectTarget !== undefined && !input!.others.some((o) => o.id === r.expectTarget)) fail(`expectTarget ${r.expectTarget} is not in others`);
  return r as EvalItem;
}

export function loadItems(path: string): EvalItem[] {
  const seen = new Set<string>();
  const items: EvalItem[] = [];
  fs.readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch (e) { throw new Error(`${path} line ${i + 1}: invalid JSON (${e instanceof Error ? e.message : e})`); }
    items.push(validate(parsed, seen));
  });
  return items;
}

/** Write JSON atomically: a temp file in the same directory, then a rename, so a crash never leaves a torn file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
