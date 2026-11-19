// The caption: a plain headline and a small monospace tag at the right, blurred in on a beat, held, blurred out.
// Left edge 1180, width 600; a dot in the moment's hue before the tag. A pure function of t.
import { vis } from './springs.js';
import { CAPTIONS, CAPTION_OUT, HUE } from './timeline.js';

/** @param {HTMLElement} el #cap */
export function createCaptions(el) {
  el.innerHTML = '<h2 id="cap-head"></h2><p id="cap-tag"></p>';
  const head = el.querySelector('#cap-head');
  const tag = el.querySelector('#cap-tag');
  let shown = null;
  return {
    draw(t) {
      const c = CAPTIONS.find((x) => t >= x.tin - 0.001 && t <= x.tout + CAPTION_OUT + 0.001) ?? null;
      if (!c) { el.style.visibility = 'hidden'; return; }
      if (shown !== c.id) {
        shown = c.id;
        head.textContent = c.head;
        tag.textContent = c.tag;
        el.style.setProperty('--h', HUE[c.hue]);
      }
      const v = vis(t, c.tin, c.tout, CAPTION_OUT);
      el.style.visibility = v.o > 0.002 ? 'visible' : 'hidden';
      el.style.opacity = v.o.toFixed(4);
      el.style.filter = v.b > 0.05 ? `blur(${v.b.toFixed(2)}px)` : 'none';
      el.style.transform = `translateY(${v.dy.toFixed(2)}px)`;
    },
  };
}
