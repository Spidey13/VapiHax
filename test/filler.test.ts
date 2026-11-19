import { describe, expect, it } from 'vitest';
import { FILLERS, FillerPicker } from '../src/reply/filler.js';

describe('FillerPicker', () => {
  it('never returns any of the previous three fillers', () => {
    for (const seed of [0, 1, 2, 3]) {
      let n = seed;
      const p = new FillerPicker(() => ((n = (n * 7 + 3) % 97) / 97));
      const picks = Array.from({ length: 50 }, () => p.pick());
      picks.forEach((f) => expect(FILLERS).toContain(f));
      picks.forEach((f, i) => expect(picks.slice(Math.max(0, i - 3), i)).not.toContain(f));
    }
  });
  it('works with the default random source', () => {
    const p = new FillerPicker();
    const picks = Array.from({ length: 50 }, () => p.pick());
    picks.forEach((f, i) => expect(picks.slice(Math.max(0, i - 3), i)).not.toContain(f));
  });
});
