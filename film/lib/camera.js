// The camera: three framings and the moves between them, as a pure function of film time.
import { ease } from './overlay.js';

/** Camera framings: the app point at the frame's centre (cx, cy, app px) and the zoom. */
export const FRAMINGS = {
  '16x9': {
    wide: { cx: 960, cy: 540, z: 1 },
    words: { cx: 960, cy: 512.4, z: 1.45 }, // the transcript column, the glow low in frame
    map: { cx: 256.7, cy: 96.7, z: 3 }, // the branch map's first row near (300, 350); the right half is for the text block
    mapWide: { cx: 335.9, cy: 165.9, z: 2.2 }, // rows showing their last lines need more width
    end: { cx: 960, cy: 400, z: 1.45 }, // the end page: the map and the notes panel
  },
  '9x16': {
    wide: { cx: 540, cy: 960, z: 1 },
    words: { cx: 540, cy: 880, z: 1.5 },
    map: { cx: 167.2, cy: 221.6, z: 3.2 },
    mapWide: { cx: 266, cy: 254, z: 2 },
    end: { cx: 790, cy: 360, z: 1.7 }, // the notes panel (the map sits beside it, out of frame)
  },
};
const WIDE_KINDS = new Set(['compare', 'recap']);
/** A framing as interpolable values: the zoom moves in log space so a push feels even from start to end. */
const lens = (f) => ({ cx: f.cx, cy: f.cy, lz: Math.log(f.z) });

/** The camera's moves in order: { at, dur, from, to } in lens values. */
export function cameraMoves(film, F) {
  const out = [];
  let cur = lens(F.wide);
  const move = (to, at, dur) => { out.push({ at, dur, from: cur, to }); cur = to; };
  for (const s of film.shots) move(lens(s.to === 'map' && WIDE_KINDS.has(s.kind) ? F.mapWide : F[s.to]), s.at, s.dur);
  move(lens(F.wide), film.numbers.at - 0.6, 0.6);
  return out;
}

/** Where the camera is at film time t (moves ease in and out, power2). */
export function cameraAt(moves, t) {
  let v = moves[0]?.from ?? { cx: 0, cy: 0, lz: 0 };
  for (const m of moves) {
    if (t < m.at) break;
    if (m.dur <= 0 || t >= m.at + m.dur) { v = m.to; continue; }
    const p = ease.power2InOut((t - m.at) / m.dur);
    v = { cx: m.from.cx + (m.to.cx - m.from.cx) * p, cy: m.from.cy + (m.to.cy - m.from.cy) * p, lz: m.from.lz + (m.to.lz - m.from.lz) * p };
    break;
  }
  return v;
}
