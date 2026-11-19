import { describe, it, expect, vi } from 'vitest';
import { ClaudeDigester, cutAtSentence, fallbackDigest } from '../src/reply/digest.js';
import type { Turn } from '../src/tree/types.js';

const t = (id: string, role: Turn['role'], text: string, extra: Partial<Turn> = {}): Turn => ({ id, branchId: 'b1', role, text, at: 0, ...extra });

describe('ClaudeDigester', () => {
  it('returns the model text and passes the signal, low effort and a roomy max_tokens', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' A weekly show. ' }] }));
    const ac = new AbortController();
    const out = await new ClaudeDigester({ client: { messages: { create } } as any, model: 'm' }).digest('Podcast', [t('t1', 'user', 'a podcast')], ac.signal);
    expect(out).toBe('A weekly show.');
    const [params, opts] = create.mock.calls[0] as any[];
    expect(params).toMatchObject({ model: 'm', max_tokens: 1024, output_config: { effort: 'low' } });
    expect(params).not.toHaveProperty('thinking');
    expect(opts.signal).toBe(ac.signal);
  });
  it('cuts the output to 150 words', async () => {
    const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const client = { messages: { create: async () => ({ content: [{ type: 'text', text: long }] }) } } as any;
    const out = await new ClaudeDigester({ client, model: 'm' }).digest('x', [t('t1', 'user', 'hi')]);
    expect(out.split(' ')).toHaveLength(150);
    expect(out.endsWith('…')).toBe(true); // no sentence end to stop at: marked as cut, not silently mid-clause
  });
  it('cuts an over-long digest at its last complete sentence', () => {
    const sentence = (k: number) => Array.from({ length: 19 }, (_, i) => `s${k}w${i}`).join(' ') + ' end.';
    const text = Array.from({ length: 9 }, (_, k) => sentence(k)).join(' '); // 180 words, 20 per sentence
    const out = cutAtSentence(text, 150);
    expect(out.endsWith('s6w18 end.')).toBe(true); // 7 whole sentences = 140 words
    expect(out.split(' ')).toHaveLength(140);
    expect(cutAtSentence('Short one.', 150)).toBe('Short one.');
  });
  it('labels corrections, carries inherited notes and tells the model a correction replaces only its detail', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const d = new ClaudeDigester({ client: { messages: { create } } as any, model: 'm' });
    await d.digest('Trip', [t('1', 'user', 'ski mornings'), t('2', 'user', 'Furano', { kind: 'correction' })], undefined, ['Thread "X": carried']);
    const [params] = create.mock.calls[0] as any[];
    const content = params.messages[0].content as string;
    expect(content).toContain('User: ski mornings');
    expect(content).toContain('User (correction): Furano');
    expect(content).toContain('Context carried from combined threads:\nThread "X": carried');
    expect(params.system).toMatch(/correction.*replac/i);
    expect(params.system).toContain('80 words');
    expect(params.system).toContain('a suggestion, not a decision');
  });
  it('throws on an error and on empty output so the caller falls back', async () => {
    const bad = { messages: { create: () => Promise.reject(new Error('x')) } } as any;
    await expect(new ClaudeDigester({ client: bad, model: 'm' }).digest('x', [])).rejects.toThrow();
    const empty = { messages: { create: async () => ({ content: [{ type: 'thinking', thinking: 'hmm' }] }) } } as any;
    await expect(new ClaudeDigester({ client: empty, model: 'm' }).digest('x', [])).rejects.toThrow('empty');
  });
});

describe('fallbackDigest', () => {
  it('is the name plus every user turn, chronologically', () => {
    const turns = [t('1', 'user', 'one'), t('2', 'assistant', 'r'), t('3', 'user', 'two'), t('4', 'user', 'three')];
    expect(fallbackDigest('Podcast', turns)).toBe('Podcast: one two three');
  });
  it('over 150 words keeps the earliest user turns and the latest correction, in order', () => {
    const w = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ');
    const turns = [t('1', 'user', 'first constraint'), t('2', 'user', w('mid', 200)), t('3', 'user', 'Furano, not Niseko', { kind: 'correction' })];
    const out = fallbackDigest('Trip', turns);
    expect(out.startsWith('Trip: first constraint ')).toBe(true);
    expect(out.endsWith('Furano, not Niseko')).toBe(true);
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(150);
  });
  it('appends inherited notes after "Earlier:" and caps the whole at 300 words', () => {
    const out = fallbackDigest('N', [t('1', 'user', 'plan')], ['Thread "A": alpha', 'Thread "B": beta']);
    expect(out).toBe('N: plan Earlier: Thread "A": alpha Thread "B": beta');
    const long = [Array.from({ length: 400 }, (_, i) => `n${i}`).join(' ')];
    expect(fallbackDigest('N', [t('1', 'user', 'plan')], long).split(/\s+/)).toHaveLength(300);
  });
  it('skips scratched turns and cuts to 150 words', () => {
    const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    expect(fallbackDigest('N', [t('1', 'user', 'gone', { scratched: true }), t('2', 'user', long)]).split(' ')).toHaveLength(150);
    expect(fallbackDigest('N', [t('1', 'user', 'gone', { scratched: true })])).toBe('N: nothing said yet.');
  });
});
