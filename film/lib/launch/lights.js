// The light: "the light is the branch". Everything here is a pure function of the film's draw context and the DOM
// the replay just built, so a frame is the same whichever order the frames are drawn in.
//
//   createLights({ layer, frame, appHost }) -> { draw(ctx) }
//   ctx = { t, src, scene, sceneT, sceneDur, zoom }
//
// layer    #lights, inside the camera (app pixels, the 960 x 1080 window)
// frame    #frame, 1920 x 1080 screen space (the end card lives here)
// appHost  #app, where the replay draws; the app's own #field glass and branch map are measured from it
//
// Moments (session seconds): ghost row + lifting words (beat 1), the fork bloom, the fix flicker, the dimmed
// blue lobe on the way back, both dots lit for compare, the merge fuse, and the end card.
// No CSS transitions or animations run on anything here; every value comes from time.

// ---- springs (private copy of the skill's stepR; closed-form damped step response, 0 -> 1) ----
function stepR(tau, { w, z }) {
  if (tau <= 0) return 0;
  if (z >= 1) { const x = w * tau; return 1 - Math.exp(-x) * (1 + x); }
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * tau) * (Math.cos(wd * tau) + (z * w / wd) * Math.sin(wd * tau));
}
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
/** The skill's vis(): enter on a spring, optional short exit. */
function vis(t, tin, tout, dOut = 0.12, w = 26) {
  const e = stepR(t - tin, { w, z: 1 });
  const x = tout == null ? 0 : clamp((t - tout) / dOut);
  const xo = x * x;
  return { o: e * (1 - xo), b: (1 - e) * 10 + xo * 10, e };
}

// ---- timings (session seconds unless noted) ----
export const LIFT_START = 32.4;     // the partial words begin to lift
export const LIFT_DUR = 1.4;
export const GHOST_IN = 33.6;       // the provisional "New path" row blurs in
export const FORK_AT = 39.24;       // the real fork row appears
export const FORK_TRAVEL = 0.7;     // the blue light's trip from the glow to the new dot
export const HANDOFF = 0.2;         // the ghost blurs out over this once the real row is there
export const FIX_AT = 55.24;        // correction: the light flickers as if to split
export const BACK_AT = 86.52;       // switch back: blue dims behind the frost
export const COMPARE_AT = 99.15;    // both dots lit ...
export const COMPARE_END = 102.15;  // ... until here
export const MERGE_DRIFT = 115.0;   // the two lobes start to drift together
export const MERGE_FUSE = 116.2;    // fused (the app's glow turns lilac)
export const END_LAND = 1.4;        // end card: seconds for the light to settle as the dot

const WIN = 960;
const HUE = { mint: [158, 60, 64], blue: [226, 88, 72], lilac: [270, 70, 76] };
const hsl = (c) => `${c[0].toFixed(1)} ${c[1].toFixed(1)}% ${c[2].toFixed(1)}%`;
const mixC = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

/** CSS ease-in-out, cubic-bezier(.42, 0, .58, 1), as the app's pulse keyframe uses it. */
function easeInOut(x) {
  x = clamp(x);
  const bez = (a, b, s) => 3 * a * (1 - s) * (1 - s) * s + 3 * b * (1 - s) * s * s + s * s * s;
  let lo = 0, hi = 1;
  for (let i = 0; i < 28; i++) { const m = (lo + hi) / 2; if (bez(0.42, 0.58, m) < x) lo = m; else hi = m; }
  return bez(0, 1, (lo + hi) / 2);
}
/** The app's `@keyframes pulse { 50% { opacity: .4 } }` at 1.8 s ease-in-out, read at `age` seconds. */
function pulse(age) {
  const p = ((age % 1.8) + 1.8) % 1.8 / 1.8;
  const u = p < 0.5 ? p / 0.5 : (1 - p) / 0.5;
  return 1 - 0.6 * easeInOut(u);
}

/** Resolves when the end card's two faces are loaded (call once before the first draw if frames are drawn out of order). */
export function loadLightFonts() {
  return Promise.all([document.fonts.load('500 112px "Instrument Sans"'), document.fonts.load('400 34px "Instrument Sans"'), document.fonts.load('400 21px "JetBrains Mono"')]);
}

export function createLights({ layer, frame, appHost }) {
  // ---- the end card (screen space) ----
  const card = document.createElement('div');
  card.className = 'lt-card';
  card.style.visibility = 'hidden'; // not display:none: the card's fonts load while it waits, so its first measure is right
  card.innerHTML = '<h1><i class="lt-slot"></i><span class="lt-name">Branch Voice</span></h1><p class="lt-sub">An MVP.</p><p class="lt-tag">84–131 ms routing · 50/54 held-out</p>';
  const light = document.createElement('i');
  light.className = 'lt-endlight';
  light.hidden = true;
  const halo = document.createElement('i');
  halo.className = 'lt-endhalo';
  halo.hidden = true;
  const ensureCard = () => { if (!card.isConnected) frame.append(card, halo, light); };
  ensureCard();
  const slot = card.querySelector('.lt-slot');
  const nameEl = card.querySelector('.lt-name');
  const subEl = card.querySelector('.lt-sub');
  const tagEl = card.querySelector('.lt-tag');
  const sx = (el, vi, dy) => { el.style.opacity = vi.o.toFixed(4); el.style.filter = vi.b > 0.05 ? `blur(${vi.b.toFixed(2)}px)` : 'none'; el.style.transform = `translateY(${((1 - vi.e) * dy).toFixed(2)}px)`; };

  // ---- measuring the replayed app, in app px ----
  function ctxm() {
    const r = appHost.getBoundingClientRect();
    const z = r.width / WIN || 1;
    return { r, z, pt: (b) => ({ x: (b.left + b.width / 2 - r.left) / z, y: (b.top + b.height / 2 - r.top) / z }) };
  }
  const rows = () => [...appHost.querySelectorAll('#branchmap .bm-list li')];
  const dotOf = (li, m) => { const d = li?.querySelector('.bm-dot'); return d ? m.pt(d.getBoundingClientRect()) : null; };
  const real = (names, m) => {
    const li = rows().find((x) => !x.classList.contains('ghost') && names.includes(x.querySelector('.bm-name')?.textContent));
    return dotOf(li, m);
  };
  const rootDot = (m) => dotOf(rows().find((x) => !x.classList.contains('ghost')), m);
  const glowAt = (m) => {
    const g = appHost.querySelector('#field .glow');
    if (!g) return { x: 480, y: 1000 };
    const b = g.getBoundingClientRect();
    return m.pt({ left: b.left, top: b.top + b.height * 0.25, width: b.width, height: b.height });
  };

  // ---- drawing helpers ----
  const mk = (cls, x, y, size, c, o, blur) => {
    const el = document.createElement('i');
    el.className = `lt ${cls}`;
    el.style.cssText = `left:${x.toFixed(2)}px;top:${y.toFixed(2)}px;width:${size.toFixed(2)}px;height:${size.toFixed(2)}px;opacity:${clamp(o).toFixed(4)};--h:${hsl(c)};`;
    if (blur != null) el.style.filter = `blur(${blur}px)`;
    layer.append(el);
    return el;
  };
  const setLobe = (field, k, g) => {
    // g = { x, y, w, h (percent of the window, as the storyboard), c (colour array or css), o }
    const s = field.style;
    s.setProperty(`--l${k}-x`, String(g.x));
    s.setProperty(`--l${k}-y`, String(g.y));
    s.setProperty(`--l${k}-w`, String(g.w));
    s.setProperty(`--l${k}-h`, String(g.h));
    s.setProperty(`--l${k}-c`, typeof g.c === 'string' ? g.c : hsl(g.c));
    s.setProperty(`--l${k}-o`, clamp(g.o).toFixed(4));
  };

  // fork: the blue light leaves the glow, travels to the new dot, blooms, settles
  const travel = (tau, from, to) => {
    const sx_ = stepR(tau, { w: 8, z: 1 });
    const sy_ = stepR(tau, { w: 10, z: 0.9 });
    return { x: lerp(from.x, to.x, sx_), y: lerp(from.y, to.y, sy_), s: sy_ };
  };
  function fork(src, m) {
    const tau = src - FORK_AT;
    if (tau < 0) return;
    const to = real(['Hokkaido ryokan', 'New path'], m);
    if (!to) return;
    const from = glowAt(m);
    const blue = HUE.blue;
    const inn = stepR(tau, { w: 30, z: 1 });
    const arrived = stepR(tau - FORK_TRAVEL, { w: 3.2, z: 1 }); // 0 -> 1 over ~1.2 s after the arrival
    const o = (0.5 + 0.4 * (1 - arrived)) * inn;
    const p = travel(tau, from, to);
    const size = lerp(150, 90, clamp(p.s));
    // the soft trail: two copies sampled at earlier times; they close up and fade as the light arrives
    const fade = 1 - smooth((tau - 0.45) / 0.4);
    if (fade > 0.01) {
      for (const [dt, k, a] of [[0.07, 0.5, 0.35], [0.14, 0.34, 0.18]]) {
        const q = travel(tau - dt, from, to);
        mk('lt-trail', q.x, q.y, size * k, blue, a * fade * inn);
      }
    }
    mk('lt-bloom', p.x, p.y, size, blue, o);
    const root = rootDot(m);
    if (root) mk('lt-bloom', root.x, root.y, 50, HUE.mint, 0.35 * stepR(tau - 0.5, { w: 12, z: 1 }));
  }

  // beat 1: the partial words lift toward the map; a provisional row pulses and hands off to the real one
  function ghost(src, m, field) {
    for (const g of appHost.querySelectorAll('li.ghost')) g.remove();
    if (src < LIFT_START || src >= FORK_AT + HANDOFF) return;
    const list = appHost.querySelector('#branchmap .bm-list');
    const all = rows().filter((x) => !x.classList.contains('ghost'));
    const rootLi = all[0];
    if (!list || !rootLi) return;
    // the provisional row: the root row's own markup, as the app draws a provisional one
    const inV = vis(src, GHOST_IN, null, 0.12, 14);
    const out = clamp((src - FORK_AT) / HANDOFF);
    const li = rootLi.cloneNode(true);
    li.classList.remove('cur', 'root', 'new', 'exp', 'aside', 'leaving');
    li.classList.add('prov', 'ghost');
    li.style.cssText = `--h:${hsl(HUE.blue)};--d:1;--span:${getComputedStyle(list).getPropertyValue('--rh').trim() || '26px'};position:absolute;left:0;top:${(all[1] ? all[1].offsetTop : rootLi.offsetTop + rootLi.offsetHeight)}px;transition:none;animation:none;`;
    li.querySelector('.bm-name').textContent = 'New path';
    const dotEl = li.querySelector('.bm-dot');
    dotEl.style.animation = 'none';
    dotEl.style.transition = 'none';
    dotEl.style.opacity = pulse(src - GHOST_IN).toFixed(4);
    li.querySelector('.bm-ln')?.remove();
    const o = 0.75 * inV.o * (1 - out);
    const b = inV.b * 0.8 + out * 6;
    li.style.opacity = o.toFixed(4);
    li.style.filter = b > 0.05 ? `blur(${b.toFixed(2)}px)` : 'none';
    list.append(li);
    const gd = m.pt(li.querySelector('.bm-dot').getBoundingClientRect());
    if (inV.o > 0.01 && out < 1) mk('lt-bloom', gd.x, gd.y, 44, HUE.blue, 0.6 * inV.o * (1 - out) * dotEl.style.opacity);

    // the lifting words
    const tau = src - LIFT_START;
    if (tau > 0 && src < FORK_AT) {
      const s = stepR(tau / LIFT_DUR, { w: 5.2, z: 1 });
      const said = [...appHost.querySelectorAll('#transcript p')].pop();
      const fb = said ? m.pt(said.getBoundingClientRect()) : { x: 480, y: 600 };
      const from = { x: fb.x, y: said ? (said.getBoundingClientRect().top - m.r.top) / m.z : fb.y };
      const to = { x: gd.x + 66, y: gd.y };
      const k = clamp(s);
      const wo = 0.42 * stepR(tau, { w: 14, z: 1 }) * (1 - smooth((k - 0.4) / 0.58));
      if (wo > 0.004) {
        const el = document.createElement('p');
        el.className = 'lt lt-lift';
        el.textContent = 'we did Hokkaido instead?';
        el.style.cssText = `left:${lerp(from.x, to.x, k).toFixed(2)}px;top:${lerp(from.y, to.y, k).toFixed(2)}px;opacity:${wo.toFixed(4)};filter:blur(${(0.4 + 2.2 * k).toFixed(2)}px);font-size:${(15 * lerp(1, 0.86, k)).toFixed(2)}px;`;
        layer.append(el);
      }
    }
  }

  function fix(src, field) {
    const KEYS = [[0, 0], [0.12, 0.55], [0.26, 0.1], [0.4, 0.4], [0.6, 0]];
    const tau = src - FIX_AT;
    let v = 0;
    if (tau > 0 && tau < 0.6) {
      for (let i = 1; i < KEYS.length; i++) {
        if (tau <= KEYS[i][0]) { const [t0, v0] = KEYS[i - 1], [t1, v1] = KEYS[i]; v = lerp(v0, v1, smooth((tau - t0) / (t1 - t0))); break; }
      }
    }
    field.style.setProperty('--split', v.toFixed(4));
    setLobe(field, 'b', { x: 54, y: 14, w: 20, h: 20, c: 'var(--cur-h)', o: 0 });
  }

  function back(src, field) {
    const tau = src - BACK_AT;
    if (tau < 0) return;
    const o = 0.22 * stepR(tau, { w: 40, z: 1 }) * (1 - smooth((tau - 0.1) / 1.4));
    setLobe(field, 'b', { x: 54, y: -3, w: 26, h: 22, c: HUE.blue, o });
  }

  function compare(src, m) {
    const tau = src - COMPARE_AT;
    if (tau < 0) return;
    const out = 1 - smooth((src - COMPARE_END) / 0.6);
    if (out <= 0) return;
    const e = stepR(tau, { w: 12, z: 0.9 });
    for (const [names, c] of [[['Tokyo and Kyoto'], HUE.mint], [['Hokkaido ryokan'], HUE.blue]]) {
      const p = real(names, m);
      if (p) mk('lt-bloom', p.x, p.y, lerp(24, 60, clamp(e, 0, 1.08)), c, 0.7 * clamp(e) * out);
    }
  }

  function merge(src, m, field) {
    const d = stepR(src - MERGE_DRIFT, { w: 4, z: 1 }); // two lobes drifting together; ~fused by 116.2
    const hueK = stepR(src - MERGE_DRIFT - 0.1, { w: 4, z: 1 });
    const A = { x: lerp(22, 39, d), y: lerp(2, 4, d), w: lerp(22, 24, d), h: lerp(24, 26, d) };
    const B = { x: lerp(56, 39, d), y: lerp(2, 4, d), w: lerp(22, 24, d), h: lerp(24, 26, d) };
    const fadeA = 1 - smooth((src - 116.5) / 1.8);
    const fadeB = 1 - smooth((src - 116.2) / 0.7);
    const rise = smooth((src - 114.7) / 0.4);
    setLobe(field, 'a', { ...A, c: mixC(HUE.mint, HUE.lilac, hueK), o: lerp(0, 0.75, rise) * fadeA });
    setLobe(field, 'b', { ...B, c: mixC(HUE.blue, HUE.lilac, hueK), o: lerp(0, 0.7, rise) * fadeB });
    const p = real(['Tokyo + Hokkaido', 'Merged path'], m);
    const tau = src - (MERGE_FUSE + 0.1);
    if (p && tau > 0) mk('lt-bloom', p.x, p.y, lerp(30, 60, clamp(stepR(tau, { w: 10, z: 0.9 }), 0, 1.06)), HUE.lilac, 0.8 * stepR(tau, { w: 10, z: 1 }));
  }

  // end: the light glides in from where the glow sat and settles as the dot beside the name
  function end(sceneT) {
    ensureCard();
    card.style.visibility = 'visible';
    light.hidden = false;
    halo.hidden = false;
    const c = HUE.lilac;
    card.style.setProperty('--h', hsl(c));
    sx(nameEl, vis(sceneT, END_LAND - 0.35, null, 0.12, 12), 14);
    sx(subEl, vis(sceneT, END_LAND + 0.05, null, 0.12, 12), 12);
    sx(tagEl, vis(sceneT, END_LAND + 0.45, null, 0.12, 12), 10);
    // the dot's rest position is the empty slot in the heading's layout
    const fr = frame.getBoundingClientRect();
    const sc = fr.width / 1920 || 1;
    const sb = slot.getBoundingClientRect();
    const rest = { x: (sb.left + sb.width / 2 - fr.left) / sc, y: (sb.top + sb.height / 2 - fr.top) / sc };
    const start = { x: 960, y: 1010 };
    // springs in scene seconds: ~97% of the way at END_LAND (1.4 s), a hair of overshoot at most
    const sxp = stepR(sceneT, { w: 4.4, z: 0.92 });
    const syp = stepR(sceneT, { w: 5.2, z: 0.92 });
    const r = clamp(stepR(sceneT, { w: 4.6, z: 1 })); // bloom -> dot
    const x = lerp(start.x, rest.x, sxp), y = lerp(start.y, rest.y, syp);
    const col = hsl(c);
    // a soft halo condenses into the dot: the halo shrinks and fades, the dot takes its ring and glow
    const H = lerp(320, 120, r);
    halo.style.cssText = `left:${x.toFixed(2)}px;top:${y.toFixed(2)}px;width:${H.toFixed(2)}px;height:${H.toFixed(2)}px;opacity:${(0.85 * (1 - r)).toFixed(4)};background:radial-gradient(closest-side, hsl(${col} / .95), hsl(${col} / .45) 45%, hsl(${col} / 0));`;
    const d = smooth(r / 0.7);
    light.style.cssText = `left:${x.toFixed(2)}px;top:${y.toFixed(2)}px;width:26px;height:26px;opacity:${d.toFixed(4)};background:hsl(${col});` +
      `box-shadow:0 0 0 ${(12 * r).toFixed(2)}px hsl(${col} / .28),0 0 60px 16px hsl(${col} / ${(0.55 * r).toFixed(3)});`;
  }

  return {
    draw(ctx) {
      const { src, scene, sceneT = 0 } = ctx;
      layer.replaceChildren();
      const showCard = scene === 'end';
      card.style.visibility = showCard ? 'visible' : 'hidden';
      light.hidden = !showCard;
      halo.hidden = !showCard;
      if (showCard) { end(sceneT); return; }
      if (src == null || !appHost) return;
      const field = appHost.querySelector('#field');
      const m = ctxm();
      if (field) {
        field.style.setProperty('--split', '0');
        for (const k of ['a', 'b']) setLobe(field, k, { x: 40, y: 0, w: 20, h: 20, c: HUE.mint, o: 0 });
        field.classList.add('lt-field');
      }
      if (scene === 'fork') { ghost(src, m, field); fork(src, m); }
      else if (scene === 'fix' && field) fix(src, field);
      else if (scene === 'switch' && field) back(src, field);
      else if (scene === 'compare') compare(src, m);
      else if (scene === 'merge' && field) merge(src, m, field);
    },
  };
}
