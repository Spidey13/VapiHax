// The camera: the app point (cx, cy) sits at the frame point (fx, 540), at zoom z. cx, cy and log z ride critically
// damped springs; a target that must be reached at T is issued ~0.35 s before (the keys in timeline.js say when).
// fx is 960 (the window centred) normally and 650 while a caption is open: the camera starts drifting 0.35 s before
// the caption blurs in and drifts back after it blurs out.
import { Track } from './springs.js';
import { FRAMES, CAPTIONS, CAPTION_OUT, camKeys } from './timeline.js';

export const FX_FULL = 960;
export const FX_CAPTION = 650;
const SP = { w: 4.2, z: 1 };

const start = FRAMES.hook;
const cx = new Track(start.cx);
const cy = new Track(start.cy);
const lz = new Track(Math.log(start.z));
const fx = new Track(FX_FULL);
for (const k of camKeys()) {
  const f = FRAMES[k.frame];
  const sp = k.sp ?? SP;
  cx.to(k.t, f.cx, sp);
  cy.to(k.t, f.cy, sp);
  lz.to(k.t, Math.log(f.z), sp);
}
// caption room: go at tin - 0.35, come back at tout + the blur-out; windows closer than that keep the room
let back = -Infinity;
const room = [];
for (const c of CAPTIONS) {
  const go = c.tin - 0.35;
  if (go < back + 0.2 && room.length) room.pop(); // the last return is cancelled: stay in the caption room
  else room.push({ t: go, v: FX_CAPTION });
  back = c.tout + CAPTION_OUT;
  room.push({ t: back, v: FX_FULL });
}
for (const e of room) fx.to(e.t, e.v, SP);

/** The camera at film time t: { cx, cy, z, fx }. */
export function camera(t) {
  return { cx: cx.at(t), cy: cy.at(t), z: Math.exp(lz.at(t)), fx: fx.at(t) };
}

/** The CSS transform that puts the app point (cx, cy) at (fx, 540) at zoom z. */
export function cameraTransform(c) {
  return `translate(${(c.fx - c.cx * c.z).toFixed(3)}px, ${(540 - c.cy * c.z).toFixed(3)}px) scale(${c.z.toFixed(5)})`;
}
