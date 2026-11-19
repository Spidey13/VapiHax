// The launch film's clock. Pure data and functions, no DOM.
//
// The beat grid (film/data/launch-beats.json) decides the film's time. Each scene starts on a beat; each scene that
// plays the real session is a window of the recording played at speed 1, and its start is solved so that its anchor
// (the fork, the correction, the switch...) lands on a downbeat. Everything else (captions, camera, sounds) is read off
// the solved scenes, so changing the beat grid moves the whole film with it.
import beatsData from '../../data/launch-beats.json' with { type: 'json' };
import sessionData from '../../data/launch-session.json' with { type: 'json' };

export const FPS = 30;
/** How long the camera takes to follow the blue light up into the map at the fork (seconds). The lights use it too. */
export const FORK_TRAVEL = 0.7;
export const SESSION = sessionData;
export const BEATS = beatsData.beats;
export const DOWNBEATS = beatsData.downbeats;

const nearest = (arr, x) => arr.reduce((b, v) => (Math.abs(v - x) < Math.abs(b - x) ? v : b), arr[0]);
export const snapBeat = (x) => nearest(BEATS, x);
export const snapDownbeat = (x) => nearest(DOWNBEATS, x);

/** Hues of the moments (HSL triplets, as the app's --cur-h). */
export const HUE = { mint: '158 60% 64%', blue: '226 88% 72%', lilac: '270 70% 76%' };

/** Camera framings: the app point (cx, cy) in the 960 x 1080 window, and the zoom. */
export const FRAMES = {
  hook: { cx: 480, cy: 540, z: 1 },
  start: { cx: 480, cy: 450, z: 1.6 },
  words: { cx: 480, cy: 470, z: 1.3 },
  wordsMap: { cx: 430, cy: 480, z: 1.1 },
  story: { cx: 430, cy: 440, z: 1.25 },
  map: { cx: 95, cy: 82, z: 3.0 }, // the rows sit near the caption (draft review)
  mapWide: { cx: 250, cy: 110, z: 2.0 },
  light: { cx: 470, cy: 650, z: 1.2 },
  end: { cx: 520, cy: 340, z: 1.15 },
};

// ---- the scenes ----
// `at` is the planned film start (seconds), snapped to the nearest beat. `src` is the planned session window; an
// anchored scene keeps its length but moves so the anchor falls on a downbeat. `trim` marks a window that ends inside
// the assistant's reply (never inside a user turn or a response wait; film/lib/cut.js checks that).
const PLAN = [
  { id: 'hook', at: 0 },
  { id: 'start', at: 4.4 },
  { id: 'setup', at: 8.1, src: 12.8, trim: true },
  { id: 'fork', at: 16.3, src: 30.2, anchor: ['fork', 39.24], trim: true },
  { id: 'fix', at: 30.5, src: 50.4, anchor: ['fix', 55.24], trim: true },
  { id: 'back', at: 41.5, src: 72.8, trim: true },
  { id: 'switch', at: 47.7, src: 86.52, anchor: ['switch', 86.518] },
  { id: 'compare', at: 51.8, src: 93.6, anchor: ['compare', 99.15], trim: true },
  { id: 'merge', at: 61.2, src: 111.4, anchor: ['merge', 115.8], trim: true },
  { id: 'notes', at: 69.6, src: 150.4, anchor: ['share', 151.16] },
  { id: 'end', at: 76.6 },
];
export const duration = snapBeat(81);

function solve() {
  const starts = PLAN.map((p) => snapBeat(p.at));
  const out = [];
  PLAN.forEach((p, i) => {
    const t0 = starts[i];
    const t1 = i + 1 < PLAN.length ? starts[i + 1] : duration;
    const s = { id: p.id, index: i, t0, t1, dur: t1 - t0, src: null, anchor: null, trim: !!p.trim };
    if (p.src != null) {
      let s0 = p.src;
      if (p.anchor) {
        const [key, a] = p.anchor;
        const film = snapDownbeat(t0 + (a - p.src)); // the downbeat nearest the anchor's planned place
        s0 = a - (film - t0);
        s.anchor = { key, src: a, film };
      }
      s.src = [round(s0), round(s0 + s.dur)];
    }
    out.push(s);
  });
  return out;
}
const round = (x) => Math.round(x * 1e4) / 1e4;

export const SCENES = solve();
export const SEAMS = SCENES.slice(1).map((s) => s.t0); // every scene boundary is a beat, and a blur-dip seam

/** The scene at film time t: { scene, index, sceneT, sceneDur, src (session seconds or null), def }. */
export function sceneAt(t) {
  const tt = Math.min(Math.max(t, 0), duration - 1e-6);
  let i = SCENES.length - 1;
  while (i > 0 && tt < SCENES[i].t0) i--;
  const s = SCENES[i];
  return { scene: s.id, index: i, sceneT: tt - s.t0, sceneDur: s.dur, src: s.src ? s.src[0] + (tt - s.t0) : null, def: s };
}
export const filmToSrc = (t) => sceneAt(t).src;
/** Film time of a session moment, or null when no scene plays it. */
export function srcToFilm(src) {
  for (const s of SCENES) if (s.src && src >= s.src[0] - 1e-9 && src <= s.src[1] + 1e-9) return s.t0 + (src - s.src[0]);
  return null;
}
const scene = (id) => SCENES.find((s) => s.id === id);
const film = (src) => { const t = srcToFilm(src); if (t == null) throw new Error(`session ${src}s is not in any scene`); return t; };

// ---- key moments, in film time ----
const startScene = scene('start');
const endScene = scene('end');
export const KEYS = {
  hookIn: [BEATS[1], BEATS[3]], // the two hook lines blur in on these beats
  hookOut: BEATS[6], // and both blur out together
  glide: startScene.t0 + 1.4, // the cursor starts gliding in
  click: snapDownbeat(scene('setup').t0 - 0.4), // the click lands on a downbeat, just before the scene swaps
  fork: scene('fork').anchor.film,
  fix: scene('fix').anchor.film,
  switch: scene('switch').anchor.film,
  compare: scene('compare').anchor.film,
  merge: scene('merge').anchor.film,
  fuse: film(116.2), // the two lights meet and turn lilac
  share: scene('notes').anchor.film,
  end: endScene.t0,
  settle: endScene.t0 + 1.4, // the light has become the dot beside the name
};

// ---- captions ----
const CAPTIONS_SRC = [
  { id: 'B1', src: [32.5, 36.5], hue: 'mint', head: 'It hears a new idea mid-sentence.', tag: 'routes partial speech on a copy' },
  { id: 'B2', src: [39.9, 43.6], hue: 'blue', head: 'A new idea gets its own branch.', tag: 'fork = copy of state' },
  { id: 'B3', src: [55.7, 59.5], hue: 'blue', head: "A correction isn't a new idea.", tag: 'scored per turn: fork · fix · switch' },
  { id: 'B4', src: [86.9, 90.4], hue: 'mint', head: 'Go back, and the detour stays out.', tag: "context = this branch's history only" },
  { id: 'B5', src: [99.4, 102.4], hue: 'mint', head: "Ask what's different. It reads both.", tag: 'branch digests built in background' },
  { id: 'B6', src: [116.4, 120.0], hue: 'lilac', head: 'Combine them. The fix comes along.', tag: 'corrections survive merges' },
  { id: 'B7', src: [151.8, 155.6], hue: 'lilac', head: 'You leave with the map and your notes.', tag: 'one line per topic, fixes folded in' },
];
const words = (s) => s.split(/\s+/).filter(Boolean);
/** Each window: blur in on a beat, hold at least max(2.6 s, 0.32 s per word), blur out on a beat. Film seconds. */
export const CAPTIONS = CAPTIONS_SRC.map((c) => {
  const tin = snapBeat(film(c.src[0]));
  const hold = Math.max(2.6, 0.32 * words(c.head).length);
  let tout = snapBeat(film(c.src[1]));
  while (tout - tin < hold) tout = BEATS[BEATS.indexOf(tout) + 1];
  return { id: c.id, head: c.head, tag: c.tag, hue: c.hue, tin, tout };
});
export const CAPTION_OUT = 0.14; // the blur-out lasts this long after tout
/** The caption window showing at film time t (including its blur-out), or null. */
export function captionAt(t) {
  return CAPTIONS.find((c) => t >= c.tin && t <= c.tout + CAPTION_OUT) ?? null;
}

// ---- camera keys: when each target is issued (film time) ----
// A target that must be reached at T is issued ~0.35 s earlier. The fork's travel is shorter and a little stiffer.
export function camKeys() {
  const k = [];
  const early = (id, frame, lead = 0.35, sp) => k.push({ t: scene(id).t0 - lead, frame, sp });
  early('start', 'start', 0.4);
  early('setup', 'words');
  early('fork', 'wordsMap');
  k.push({ t: KEYS.fork, frame: 'map', sp: { w: 6.5, z: 1 } });
  early('fix', 'story');
  k.push({ t: film(99.0), frame: 'mapWide' });
  early('merge', 'light');
  early('notes', 'end');
  early('end', 'hook');
  return k.sort((a, b) => a.t - b.t);
}

// ---- sound cues (the plan's Sound section) ----
const hash = (i) => { const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453; return x - Math.floor(x); };

function newWordTimes() {
  // each transcript event shows the words that weren't on screen before it (the app prints the text it is given)
  const prev = { user: [], assistant: [] };
  const out = [];
  for (const e of [...SESSION.events].sort((a, b) => a.t - b.t)) {
    if (e.type !== 'transcript') continue;
    const role = e.role === 'assistant' ? 'assistant' : 'user';
    const now = words(e.text.toLowerCase());
    let common = 0;
    while (common < now.length && common < prev[role].length && now[common] === prev[role][common]) common++;
    prev[role] = now;
    const n = now.length - common;
    if (n > 0) out.push({ src: e.t, n });
  }
  return out;
}

/** [{ t, kind, gain, pan }] in film seconds, sorted. */
export function cues() {
  const out = [];
  // ticks: one per newly shown word of the visible transcript, 55 ms apart at least
  const ticks = [];
  for (const w of newWordTimes()) {
    const s = SCENES.find((x) => x.src && w.src >= x.src[0] && w.src < x.src[1]);
    if (!s) continue;
    const step = Math.min(0.09, 0.4 / w.n);
    for (let i = 0; i < w.n; i++) {
      const t = s.t0 + (w.src - s.src[0]) + i * step;
      if (t < s.t1) ticks.push(t);
    }
  }
  ticks.sort((a, b) => a - b);
  let last = -1;
  ticks.forEach((t, i) => {
    if (t - last < 0.055) return;
    last = t;
    out.push({ t: round(t), kind: 'tick', gain: round(0.12 + 0.08 * hash(i)), pan: round((hash(i + 99) - 0.5) * 0.3) });
  });
  const add = (t, kind, gain, pan = 0) => out.push({ t: round(t), kind, gain, pan });
  add(KEYS.click, 'press', 0.5);
  add(KEYS.click + 0.14, 'release', 0.35);
  add(KEYS.fork, 'fork', 0.5, -0.6);
  add(KEYS.fork, 'fork', 0.5, 0.6);
  add(KEYS.fix, 'fix', 0.2);
  add(KEYS.switch, 'back', 0.4);
  add(KEYS.compare, 'compare', 0.4, -0.6);
  add(KEYS.compare + 0.3, 'compare', 0.4, 0.6);
  add(KEYS.merge, 'merge', 0.55);
  add(KEYS.settle, 'settle', 0.45);
  return out.sort((a, b) => a.t - b.t);
}
