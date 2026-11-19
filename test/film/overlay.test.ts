import { describe, it, expect } from 'vitest';
import { lineAt } from '../../film/lib/overlay.js';
import { cameraAt } from '../../film/lib/camera.js';

describe('lineAt', () => {
  it('is hidden before, blurs in over 0.18 s, holds still, blurs out over 0.2 s', () => {
    expect(lineAt(0.9, 1, 3).opacity).toBe('0');
    expect(Number(lineAt(1.09, 1, 3).opacity)).toBeGreaterThan(0.5);
    expect(lineAt(2, 1, 3)).toEqual({ opacity: '1', filter: 'none', visibility: 'visible' });
    expect(lineAt(0.5, 1, 3).visibility).toBe('hidden');
    expect(Number(lineAt(2.9, 1, 3).opacity)).toBeLessThan(1);
    expect(lineAt(3, 1, 3).opacity).toBe('0');
  });
});

describe('cameraAt', () => {
  const a = { cx: 0, cy: 0, lz: 0 };
  const b = { cx: 100, cy: 50, lz: Math.log(3) };
  const moves = [{ at: 0, dur: 0, from: a, to: a }, { at: 2, dur: 1, from: a, to: b }];
  it('holds, eases through the move, and lands', () => {
    expect(cameraAt(moves, 1)).toEqual(a);
    expect(cameraAt(moves, 2.5).cx).toBeCloseTo(50);
    expect(cameraAt(moves, 4)).toEqual(b);
  });
  it('is the same whatever was drawn before (a pure function of time)', () => {
    const order = [3.9, 0.5, 2.25, 2.25];
    const got = order.map((t) => cameraAt(moves, t));
    expect(got[2]).toEqual(got[3]);
  });
});
