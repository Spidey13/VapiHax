// The film's own screens: the hook, the start screen with its one click, the end's glass, and the seam between
// scenes. Everything is a function of t; nothing here animates by itself (launch.css switches the app's CSS
// animations and transitions off on these screens).
import { stepR, vis, clamp, smooth, Track } from './springs.js';
import { KEYS, SEAMS, HUE } from './timeline.js';

/** The app's glass (public/index.html): a faint wash, one glow, one frosted layer. */
export const GLASS = '<div id="field" aria-hidden="true"><i class="amb"></i><i class="glow"><i class="core"></i></i></div><div id="frost" aria-hidden="true"></div>';
const START = `<main id="start-screen">
    <h1>Think out loud. Nothing gets lost.</h1>
    <p class="lede">Talk an idea through. When you change direction, the old thread waits in the background.</p>
    <button id="btn-start" class="primary" type="button">Start talking</button>
  </main>`;

const HOOK_LINES = ["Ideas don't go in a straight line.", 'Voice assistants do.'];

// ---- the seam between two scenes: the app layer blurs and dims, swaps on the beat, and comes back ----
const SEAM_IN = 0.18;
const SEAM_OUT = 0.24;
/** { blur (px, in frame pixels), op } for the app layer at film time t. */
export function seamFx(t) {
  let k = 0;
  for (const b of SEAMS) {
    const d = t - b;
    if (d >= -SEAM_IN && d < 0) k = Math.max(k, smooth(1 + d / SEAM_IN));
    else if (d >= 0 && d < SEAM_OUT) k = Math.max(k, smooth(1 - d / SEAM_OUT));
  }
  return { blur: 8 * k, op: 1 - 0.45 * k };
}

// ---- the hook: two lines, each blurred in on a beat, both out together ----
export function createHook(el) {
  el.innerHTML = HOOK_LINES.map((l) => `<p>${l}</p>`).join('');
  const lines = [...el.children];
  return {
    draw(t) {
      const live = t < KEYS.hookOut + 0.4;
      el.style.visibility = live ? 'visible' : 'hidden';
      if (!live) return;
      lines.forEach((p, i) => {
        const v = vis(t, KEYS.hookIn[i], KEYS.hookOut, 0.2);
        p.style.opacity = v.o.toFixed(4);
        p.style.filter = v.b > 0.05 ? `blur(${v.b.toFixed(2)}px)` : 'none';
        p.style.transform = `translateY(${v.dy.toFixed(2)}px)`;
      });
    },
  };
}

// ---- the start screen's cursor: glides in on a spring, one click on a downbeat ----
const CURSOR_FROM = { x: 770, y: 830 };
const PRESS_AT = KEYS.click;

/**
 * The app host shows one of the film's own screens (hook, start, end) as the app's glass plus the start markup.
 * `host` is #app; `cursorLayer` is inside the camera, above the lights.
 */
export function createScreens({ host, cursorLayer }) {
  cursorLayer.innerHTML = '<i id="ripple"></i><i id="cursor"></i>';
  const ripple = cursorLayer.querySelector('#ripple');
  const cursor = cursorLayer.querySelector('#cursor');
  let built = false;
  let els = null;
  let target = { x: 480, y: 600 };
  let cx = null;
  let cy = null;

  function build() {
    host.innerHTML = GLASS + START;
    host.classList.add('screen');
    const btn = host.querySelector('#btn-start');
    // the button's centre in app px (offsets ignore the camera's transform)
    target = { x: btn.offsetLeft + btn.offsetWidth * 0.62, y: btn.offsetTop + btn.offsetHeight * 0.58 };
    els = { start: host.querySelector('#start-screen'), btn, field: host.querySelector('#field'), glow: host.querySelector('.glow'), core: host.querySelector('.core') };
    const sp = { w: 5.2, z: 1 };
    cx = new Track(CURSOR_FROM.x).to(KEYS.glide, target.x, sp);
    cy = new Track(CURSOR_FROM.y).to(KEYS.glide + 0.06, target.y, { w: 4.6, z: 1 });
    built = true;
  }

  return {
    /** The replay drew over the host: the screens must be rebuilt next time. */
    invalidate() { built = false; host.classList.remove('screen'); cursorLayer.style.visibility = 'hidden'; ripple.style.visibility = 'hidden'; },
    /** kind: 'hook' | 'start' | 'end' */
    draw(kind, t) {
      if (!built) build();
      const hue = kind === 'end' ? HUE.lilac : HUE.mint;
      document.body.style.setProperty('--cur-h', hue);
      els.start.style.visibility = kind === 'start' ? 'visible' : 'hidden';

      // the glow: rises from nothing, breathes (the app's 6 s breathe, as a function of t), brightens on the click
      const rise = kind === 'end' ? 1 : stepR(t - 0.15, { w: 1.5, z: 1 });
      const v = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 6);
      const k = kind === 'start' ? stepR(t - PRESS_AT, { w: 7, z: 1 }) : 0;
      els.core.style.opacity = (1 - 0.4 * v).toFixed(4);
      els.core.style.scale = (1 + 0.06 * v).toFixed(4);
      els.glow.style.opacity = (0.78 * rise).toFixed(4);
      els.glow.style.scale = ((0.88 + 0.12 * rise) * (1 + 0.05 * k)).toFixed(4);
      els.field.style.setProperty('--bright', (1 + 0.12 * k).toFixed(4));
      els.field.style.setProperty('--sat', (1 + 0.2 * k).toFixed(4));

      // the cursor
      const show = kind === 'start' && t >= KEYS.glide - 0.1;
      cursorLayer.style.visibility = show ? 'visible' : 'hidden';
      if (!show) { ripple.style.visibility = 'hidden'; return; }
      const x = cx.at(t);
      const y = cy.at(t);
      const dt = 0.012;
      const vx = (cx.at(t + dt) - cx.at(t - dt)) / (2 * dt);
      const lean = clamp(-vx * 0.0045, -14, 14);
      const born = stepR(t - (KEYS.glide - 0.1), { w: 14, z: 1 });
      const press = 1 - 0.16 * Math.exp(-(((t - PRESS_AT) / 0.045) ** 2));
      const gone = 1 - smooth((t - (PRESS_AT + 0.25)) / 0.3);
      cursor.style.left = `${x.toFixed(2)}px`;
      cursor.style.top = `${y.toFixed(2)}px`;
      cursor.style.opacity = (born * gone).toFixed(4);
      cursor.style.transform = `rotate(${lean.toFixed(2)}deg) scale(${(press * (0.7 + 0.3 * born)).toFixed(4)})`;
      // the button gives a little under the press
      const bp = Math.exp(-(((t - PRESS_AT) / 0.07) ** 2));
      els.btn.style.transform = `scale(${(1 - 0.035 * bp).toFixed(4)})`;
      // a small ripple ring, 0.4 s
      const rt = (t - PRESS_AT) / 0.4;
      if (rt > 0 && rt < 1) {
        const e = 1 - (1 - rt) * (1 - rt);
        ripple.style.visibility = 'visible';
        ripple.style.left = `${target.x.toFixed(2)}px`;
        ripple.style.top = `${target.y.toFixed(2)}px`;
        ripple.style.opacity = (0.55 * (1 - rt)).toFixed(4);
        ripple.style.width = ripple.style.height = `${(10 + 46 * e).toFixed(2)}px`;
      } else ripple.style.visibility = 'hidden';
    },
  };
}
