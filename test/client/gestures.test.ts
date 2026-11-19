import { describe, it, expect } from 'vitest';
import { swipeIntent } from '../../public/js/gestures.js';

describe('swipeIntent', () => {
  it('switch-back on a quick downward swipe from the header', () => {
    expect(swipeIntent({ dy: 120, dt: 300, startedAtTop: true })).toBe('switch-back');
  });
  it('null for a small vertical scroll', () => {
    expect(swipeIntent({ dy: 40, dt: 300, startedAtTop: true })).toBeNull();
  });
  it('null when not started at the header', () => {
    expect(swipeIntent({ dy: 120, dt: 300, startedAtTop: false })).toBeNull();
  });
  it('null when too slow', () => {
    expect(swipeIntent({ dy: 120, dt: 900, startedAtTop: true })).toBeNull();
  });
  it('boundaries are inclusive', () => {
    expect(swipeIntent({ dy: 80, dt: 600, startedAtTop: true })).toBe('switch-back');
  });
  it('null for upward swipe', () => {
    expect(swipeIntent({ dy: -120, dt: 300, startedAtTop: true })).toBeNull();
  });
});
