// The film's own layer (title, text blocks, subtitles, tags, numbers, end card, the opener) as a pure function
// of film time: element id -> inline style. No tweens, so any frame renders the same on its own.

const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const ease = {
  power4Out: (p) => 1 - (1 - p) ** 4,
  power2Out: (p) => 1 - (1 - p) ** 2,
  power2In: (p) => p * p,
  power2InOut: (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2),
  expoOut: (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
};

/** A line that blurs in (8 px to 0 in 0.18 s), holds dead still, and blurs out over the 0.2 s before `out`. */
export function lineAt(t, inAt, out) {
  if (t < inAt || t >= out) return { opacity: '0', filter: 'blur(8px)', visibility: 'hidden' };
  if (t < inAt + 0.18) { const p = ease.power4Out((t - inAt) / 0.18); return { opacity: p.toFixed(3), filter: `blur(${(8 * (1 - p)).toFixed(2)}px)`, visibility: 'visible' }; }
  if (t >= out - 0.2) { const q = ease.power2In((t - (out - 0.2)) / 0.2); return { opacity: (1 - q).toFixed(3), filter: `blur(${(6 * q).toFixed(2)}px)`, visibility: 'visible' }; }
  return { opacity: '1', filter: 'none', visibility: 'visible' };
}

/** Fade in over `fin`, out over `fout` before `end`. */
function fadeAt(t, at, end, fin, fout) {
  if (t < at || t >= end) return 0;
  if (t < at + fin) return ease.power2Out((t - at) / fin);
  if (t > end - fout) return 1 - ease.power2In((t - (end - fout)) / fout);
  return 1;
}

/**
 * @param {ReturnType<import('./plan.js').buildFilm>} film
 * @param {number} t film seconds
 * @param {{ openerZoom: { scale: number, x: number, y: number } }} o
 * @returns {Record<string, Record<string, string>>} element id -> style properties
 */
export function overlayAt(film, t, { openerZoom }) {
  const s = {};
  const firstAt = film.segments[0]?.at ?? 0;

  // the app's text (the glass and glow stay): only during the session part
  let ui = 0;
  if (t >= firstAt) ui = ease.power2Out(clamp01((t - firstAt) / 0.4));
  if (t >= film.numbers.at - 0.35) ui = 1 - ease.power2In(clamp01((t - (film.numbers.at - 0.35)) / 0.35));
  s.app = { '--film-ui': ui.toFixed(3) };

  // the opener: the real recording, one push onto the branch map, then a blur-out
  if (film.opener) {
    const d = film.opener.dur;
    const out = t >= d - 0.25 ? ease.power2In(clamp01((t - (d - 0.25)) / 0.25)) : 0;
    s.opener = { opacity: t < d ? (1 - out).toFixed(3) : '0', filter: out > 0 ? `blur(${(8 * out).toFixed(2)}px)` : 'none', visibility: t < d ? 'visible' : 'hidden' };
    const zAt = film.opener.zoom ? film.opener.zoom.at - film.opener.src[0] : Infinity;
    const p = ease.power2InOut(clamp01((t - zAt) / 0.9));
    const sc = 1 + (openerZoom.scale - 1) * p;
    s['opener-zoom'] = { transform: `translate(${(openerZoom.x * p).toFixed(2)}px, ${(openerZoom.y * p).toFixed(2)}px) scale(${sc.toFixed(4)})`, 'transform-origin': '0 0' };
    s['tag-rec'] = { opacity: t < d - 0.25 ? '1' : '0', visibility: t < d - 0.25 ? 'visible' : 'hidden' };
  } else {
    s.opener = { opacity: '0', visibility: 'hidden' };
    s['tag-rec'] = { opacity: '0' };
  }
  const tf = fadeAt(t, firstAt + 0.2, film.numbers.at, 0.3, 0.25);
  s['tag-film'] = { opacity: tf.toFixed(3), visibility: tf > 0 ? 'visible' : 'hidden' };

  // title
  const ti = film.title;
  s['title-name'] = lineAt(t, ti.at + 0.15, ti.at + ti.dur);
  s['title-line'] = lineAt(t, ti.at + 0.3, ti.at + ti.dur);

  // text blocks: the rule draws out, title and line blur in, all leave together
  film.cards.forEach((c, i) => {
    const end = c.at + c.dur;
    s[`card-${i}-title`] = lineAt(t, c.at, end);
    s[`card-${i}-line`] = lineAt(t, c.at + 0.1, end);
    const grow = t < c.at ? 0 : ease.expoOut(clamp01((t - c.at) / 0.35));
    const fade = t >= end - 0.2 ? 1 - clamp01((t - (end - 0.2)) / 0.2) : 1;
    s[`card-${i}-rule`] = { transform: `scaleX(${grow.toFixed(4)})`, opacity: (t < end ? fade : 0).toFixed(3) };
  });

  // subtitles
  film.subs.forEach((x, i) => {
    const a = fadeAt(t, x.at, x.at + x.dur, 0.15, 0.12);
    s[`sub-${i}`] = { opacity: a.toFixed(3), visibility: a > 0 ? 'visible' : 'hidden' };
  });

  // numbers, then the end card
  const n = film.numbers;
  const half = n.at + Math.min(2.9, n.dur * 0.55); // "50 of 54" reads for 2.6 s, then "0 false forks"
  s['num-a-big'] = lineAt(t, n.at + 0.2, half);
  s['num-a-line'] = lineAt(t, n.at + 0.3, half);
  s['num-b-big'] = lineAt(t, half + 0.05, n.at + n.dur);
  s['num-b-line'] = lineAt(t, half + 0.15, n.at + n.dur);
  s['num-note'] = lineAt(t, n.at + 0.4, n.at + n.dur);
  const e = film.endCard;
  s['end-name'] = lineAt(t, e.at + 0.15, film.duration + 1);
  s['end-link'] = lineAt(t, e.at + 0.45, film.duration + 1);
  return s;
}
