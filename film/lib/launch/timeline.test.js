// The film's clock keeps its promises: an honest cut, an ordered and contiguous timeline, anchors and scene starts on the
// beat grid, and a length of 72-82 s.   node --test film/lib/launch/
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCut } from '../cut.js';
import { SCENES, SESSION, BEATS, DOWNBEATS, duration, cues } from './timeline.js';

const onGrid = (grid, t) => grid.some((b) => Math.abs(b - t) < 0.001);

test('the session windows pass the honesty check, in order, played at speed 1', () => {
  const beats = SCENES.filter((s) => s.src).map((s) => ({ id: s.id, src: s.src, trim: s.trim }));
  assert.deepEqual(checkCut({ beats }, SESSION.events), []);
  for (const s of SCENES.filter((x) => x.src)) assert.ok(Math.abs(s.src[1] - s.src[0] - s.dur) < 1e-3, `${s.id} plays at speed 1`);
});

test('scenes are contiguous and start on a beat; anchors land on a downbeat', () => {
  assert.equal(SCENES[0].t0, 0);
  SCENES.forEach((s, i) => {
    if (i) assert.equal(s.t0, SCENES[i - 1].t1, `${s.id} starts where the last ends`);
    assert.ok(s.dur > 0, `${s.id} has length`);
    assert.ok(onGrid(BEATS, s.t0), `${s.id} starts on a beat (${s.t0})`);
    if (s.anchor) {
      assert.ok(onGrid(DOWNBEATS, s.anchor.film), `${s.id} anchor on a downbeat (${s.anchor.film})`);
      assert.ok(Math.abs(s.src[0] + (s.anchor.film - s.t0) - s.anchor.src) < 1e-3, `${s.id} anchor is where the session says`);
    }
  });
  assert.equal(SCENES.at(-1).t1, duration);
});

test('the film is 72-82 s', () => {
  assert.ok(duration >= 72 && duration <= 82, `duration ${duration}`);
});

test('the cue list is sorted and its ticks are at least 55 ms apart', () => {
  const c = cues();
  const ticks = c.filter((x) => x.kind === 'tick').map((x) => x.t);
  assert.ok(ticks.length > 40);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] - ticks[i - 1] >= 0.055 - 1e-6);
  for (let i = 1; i < c.length; i++) assert.ok(c[i].t >= c[i - 1].t);
});
