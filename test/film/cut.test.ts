import { describe, it, expect } from 'vitest';
import { speechWindows, protectedSpans, checkCut as check } from '../../film/lib/cut.js';

const checkCut = (cut: any, ev: any): string[] => check(cut, ev);

const sp = (t: number, role: string, status: string) => ({ t, type: 'speech', role, status });
// greeting 0.5-2.0; user 3.0-5.0 and 5.6-7.0 (a pause inside one turn); reply 8.4-12.0; user 14.0-16.0; reply 17.2-20.0
const events = [
  sp(0.5, 'assistant', 'started'), sp(2.0, 'assistant', 'stopped'),
  sp(3.0, 'user', 'started'), sp(5.0, 'user', 'stopped'), sp(5.6, 'user', 'started'), sp(7.0, 'user', 'stopped'),
  sp(8.4, 'assistant', 'started'), sp(12.0, 'assistant', 'stopped'),
  sp(14.0, 'user', 'started'), sp(16.0, 'user', 'stopped'),
  sp(17.2, 'assistant', 'started'), sp(20.0, 'assistant', 'stopped'),
];

describe('speechWindows', () => {
  it('pairs starts and stops per role', () => {
    expect(speechWindows(events).filter((w: any) => w.role === 'user')).toEqual([
      { role: 'user', start: 3, end: 5 }, { role: 'user', start: 5.6, end: 7 }, { role: 'user', start: 14, end: 16 },
    ]);
  });
});

describe('protectedSpans', () => {
  it('covers each turn from the first user word to the reply start, and every speech window', () => {
    const spans = protectedSpans(events);
    expect(spans).toContainEqual([3, 8.4]);
    expect(spans).toContainEqual([14, 17.2]);
    expect(spans).toContainEqual([8.4, 12]);
  });
});

describe('checkCut', () => {
  const ok = { beats: [{ id: 'a', src: [2.5, 13.0] }, { id: 'b', src: [13.5, 20.5] }] };
  it('accepts boundaries in the quiet after a reply', () => {
    expect(checkCut(ok, events)).toEqual([]);
  });
  it('rejects a boundary inside the response gap', () => {
    const errs = checkCut({ beats: [{ id: 'a', src: [2.5, 7.8] }, { id: 'b', src: [8.2, 13] }] }, events);
    expect(errs.join(' ')).toMatch(/a.*end 7\.8/);
    expect(errs.join(' ')).toMatch(/b.*start 8\.2/);
  });
  it('rejects a boundary inside speech and any playback rate other than 1', () => {
    expect(checkCut({ beats: [{ id: 'a', src: [2.5, 10] }] }, events).length).toBe(1);
    expect(checkCut({ beats: [{ id: 'a', src: [2.5, 13], rate: 1.1 }] }, events).join(' ')).toMatch(/rate/);
    expect(checkCut({ beats: [{ id: 'a', src: [2.5, 13], rate: 1 }] }, events)).toEqual([]);
  });
  it('lets the opener end during a reply (it fades out) but not inside a response gap', () => {
    expect(checkCut({ opener: { src: [2.5, 10] }, beats: [] }, events)).toEqual([]);
    expect(checkCut({ opener: { src: [2.5, 8] }, beats: [] }, events).length).toBe(1);
  });
  it('lets a beat marked trim end inside a reply, but never inside a wait', () => {
    expect(checkCut({ beats: [{ id: 'a', src: [2.5, 10], trim: true }] }, events)).toEqual([]);
    expect(checkCut({ beats: [{ id: 'a', src: [2.5, 8], trim: true }] }, events).length).toBe(1);
    expect(checkCut({ beats: [{ id: 'a', src: [9, 13], trim: true }] }, events).length).toBe(1); // start is never trimmed
  });
  it('rejects beats that overlap or run backwards', () => {
    expect(checkCut({ beats: [{ id: 'a', src: [2.5, 13] }, { id: 'b', src: [12.5, 20.5] }] }, events).join(' ')).toMatch(/overlap|order/);
  });
});
