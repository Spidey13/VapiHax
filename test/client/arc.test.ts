import { describe, it, expect } from 'vitest';
import { arcProgress } from '../../public/js/arc.js';

describe('arcProgress', () => {
  it('is proportional to elapsed wait', () => {
    expect(arcProgress(1500, 1000, 2600)).toBeCloseTo(0.192, 3);
  });
  it('clamps to 1 after the wait', () => {
    expect(arcProgress(9000, 1000, 2600)).toBe(1);
  });
  it('is 0 with null stop time', () => {
    expect(arcProgress(1500, null, 2600)).toBe(0);
  });
  it('clamps negative elapsed to 0 and handles zero wait', () => {
    expect(arcProgress(500, 1000, 2600)).toBe(0);
    expect(arcProgress(1500, 1000, 0)).toBe(1);
  });
});
