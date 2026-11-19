import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheKey, loadItems, splitOf, writeJsonAtomic } from '../src/route/evalData.js';
import { ROUTER_SPEC_VERSION } from '../src/route/jev.js';
import type { EvalItem } from '../src/route/score.js';

const base = (id: string, over: Partial<EvalItem> = {}): EvalItem => ({
  id,
  input: { utterance: 'Make it Thursday.', current: { id: 'b1', name: 'News', summary: 's', provisional: false, lastUser: 'Tuesday', lastAssistant: 'ok' }, others: [{ id: 'b2', name: 'Pod', summary: 'p' }] },
  expect: 'correct',
  ...over,
});

function load(...lines: string[]): EvalItem[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaldata-'));
  const file = path.join(dir, 'items.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  try { return loadItems(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const j = (i: unknown): string => JSON.stringify(i);

describe('loadItems', () => {
  it('loads valid rows and skips blank lines', () => {
    expect(load(j(base('a')), '', j(base('b')))).toHaveLength(2);
  });
  it('rejects an expectTarget that is not in others, naming the id', () => {
    expect(() => load(j(base('sw-x', { expect: 'switch', expectTarget: 'b9' })))).toThrow(/item sw-x: .*b9/);
  });
  it('rejects malformed JSON naming the line number', () => {
    expect(() => load(j(base('a')), '{not json')).toThrow(/line 2/);
  });
  it('rejects an unknown expect kind', () => {
    expect(() => load(j({ ...base('a'), expect: 'teleport' }))).toThrow(/item a: .*teleport/);
  });
  it('rejects duplicate ids', () => {
    expect(() => load(j(base('a')), j(base('a')))).toThrow(/item a: duplicate/);
  });
  it('rejects a switch without a target', () => {
    expect(() => load(j(base('a', { expect: 'switch' })))).toThrow(/item a: .*expectTarget/);
  });
});

describe('splitOf', () => {
  it('is stable', () => {
    expect(splitOf('cont-1')).toBe(splitOf('cont-1'));
  });
  it('is roughly 70/30 over 1000 synthetic ids', () => {
    let tune = 0;
    for (let i = 0; i < 1000; i++) if (splitOf(`item-${i}`) === 'tune') tune++;
    expect(tune / 1000).toBeGreaterThan(0.65);
    expect(tune / 1000).toBeLessThan(0.75);
  });
});

describe('cacheKey', () => {
  it('is stable and includes the id', () => {
    expect(cacheKey(base('a'))).toBe(cacheKey(base('a')));
    expect(cacheKey(base('a')).startsWith('a:')).toBe(true);
  });
  it('changes when the utterance changes', () => {
    const a = base('a');
    const b = base('a');
    b.input.utterance = 'Make it Friday.';
    expect(cacheKey(a)).not.toBe(cacheKey(b));
  });
  it('changes when the router spec changes', () => {
    expect(cacheKey(base('a'), 'spec-1')).not.toBe(cacheKey(base('a'), 'spec-2'));
  });
  it('defaults to the current ROUTER_SPEC_VERSION', () => {
    expect(cacheKey(base('a'))).toBe(cacheKey(base('a'), ROUTER_SPEC_VERSION));
  });
  it('does not change when only the label changes', () => {
    expect(cacheKey(base('a'))).toBe(cacheKey(base('a', { expect: 'fork' })));
  });
});

describe('more validation and atomic writes', () => {
  it('rejects a merge without an expectTarget', () => {
    expect(() => load(j(base('a', { expect: 'merge' })))).toThrow(/item a: .*expectTarget/);
  });
  it('writeJsonAtomic writes valid JSON and leaves no temp file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
    try {
      const file = path.join(dir, 'sub', 'cache.json');
      writeJsonAtomic(file, { a: 1 });
      writeJsonAtomic(file, { a: 2 });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 2 });
      expect(fs.readdirSync(path.dirname(file))).toEqual(['cache.json']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
