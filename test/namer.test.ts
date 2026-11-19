import { describe, it, expect } from 'vitest';
import { cleanName, ClaudeNamer } from '../src/reply/namer.js';

describe('cleanName', () => {
  it('strips quotes and punctuation and keeps at most four words', () => {
    expect(cleanName('"Podcast instead."')).toBe('Podcast instead');
    expect(cleanName('A weekly design podcast with guests')).toBe('A weekly design podcast');
  });
  it('returns null when nothing alphanumeric remains', () => expect(cleanName(' - ')).toBeNull());
  it('returns null for empty output', () => expect(cleanName('  "" ')).toBeNull());
});

describe('ClaudeNamer', () => {
  it('returns null when the call throws', async () => {
    const client = { messages: { create: () => Promise.reject(new Error('x')) } } as any;
    expect(await new ClaudeNamer({ client, model: 'm' }).name('or a podcast?')).toBeNull();
  });
  it('cleans the model text', async () => {
    const client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Podcast with guests!' }] }) } } as any;
    expect(await new ClaudeNamer({ client, model: 'm' }).name('or a podcast with guests?')).toBe('Podcast with guests');
  });
});
