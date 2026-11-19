import { describe, expect, it } from 'vitest';
import { SentenceChunker } from '../src/turn/sentences.js';

describe('SentenceChunker', () => {
  it('emits a sentence only once its terminator is followed by whitespace', () => {
    const c = new SentenceChunker();
    expect(c.push('Hi there. How')).toEqual(['Hi there.']);
    expect(c.push(' are you? ')).toEqual(['How are you?']);
  });
  it('flush returns trailing text without a terminator, then null', () => {
    const c = new SentenceChunker();
    c.push('Half a thought');
    expect(c.flush()).toBe('Half a thought');
    expect(c.flush()).toBeNull();
  });
  it('flush emits a terminated sentence still waiting for whitespace', () => {
    const c = new SentenceChunker();
    expect(c.push('Done.')).toEqual([]);
    expect(c.flush()).toBe('Done.');
  });
  it('does not split inside a number', () => {
    expect(new SentenceChunker().push('3.5 days')).toEqual([]);
  });

  describe('finishComplete', () => {
    it('returns buffered text only when it ends in a sentence terminator', () => {
      const broken = new SentenceChunker();
      broken.push('unfinished cho');
      expect(broken.finishComplete()).toBeNull();
      expect(broken.flush()).toBeNull(); // the fragment is dropped, not kept
      const complete = new SentenceChunker();
      complete.push('A complete sentence.');
      expect(complete.finishComplete()).toBe('A complete sentence.');
      expect(complete.finishComplete()).toBeNull();
    });
    it('accepts closing quotes and brackets after the terminator, and punctuation split across deltas', () => {
      const q = new SentenceChunker();
      q.push('She said "go.');
      q.push('"');
      expect(q.finishComplete()).toBe('She said "go."');
      const b = new SentenceChunker();
      b.push('Done (really!)');
      expect(b.finishComplete()).toBe('Done (really!)');
      const c = new SentenceChunker();
      expect(c.push('Wait.')).toEqual([]);
      c.push('.');
      expect(c.finishComplete()).toBe('Wait..');
    });
    it('rejects a mid-sentence or comma ending', () => {
      const c = new SentenceChunker();
      c.push('Well, and then');
      expect(c.finishComplete()).toBeNull();
      const d = new SentenceChunker();
      d.push('First, ');
      expect(d.finishComplete()).toBeNull();
    });
  });
});
