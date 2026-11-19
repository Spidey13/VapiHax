// The honesty check for the film's cut. A cut may only fall in the quiet after a reply has ended and before the
// user speaks again: never inside anyone's speech, and never between the start of a user's turn and the start of
// the reply (that wait is the real response time). Nothing may change playback speed.

/** @typedef {{ t: number, type: string, role?: string, status?: string }} Ev */

/** @param {Ev[]} events  @returns {{ role: string, start: number, end: number }[]} */
export function speechWindows(events) {
  const open = {};
  const out = [];
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.type !== 'speech') continue;
    if (e.status === 'started') { if (open[e.role] == null) open[e.role] = e.t; }
    else if (e.status === 'stopped' && open[e.role] != null) { out.push({ role: e.role, start: open[e.role], end: e.t }); open[e.role] = null; }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Each turn, from its first user word to the start of the reply (the user's pauses and the real wait). */
export function turnSpans(events) {
  const spans = [];
  let turnStart = null;
  for (const x of speechWindows(events)) {
    if (x.role === 'user') { if (turnStart == null) turnStart = x.start; }
    else if (turnStart != null) { spans.push([turnStart, x.start]); turnStart = null; }
  }
  return spans;
}

/** Spans no cut may fall inside: every speech window and every turn span. */
export function protectedSpans(events) {
  return [...speechWindows(events).map((x) => [x.start, x.end]), ...turnSpans(events)];
}

const inside = (t, [a, b]) => t > a + 1e-6 && t < b - 1e-6;

/**
 * A beat with `trim: true` may end inside a reply (after a sentence; the film fades it out), never inside a wait.
 * @param {{ opener?: { src: [number, number] }, beats: { id: string, src: [number, number], rate?: number, trim?: boolean }[] }} cut
 * @param {Ev[]} events session events, seconds of the recording
 * @returns {string[]} problems; empty when the cut is honest
 */
export function checkCut(cut, events) {
  const errs = [];
  const spans = protectedSpans(events);
  const gaps = turnSpans(events);
  const check = (label, which, t, allowInSpeech = false) => {
    const hit = (allowInSpeech ? gaps : spans).find((s) => inside(t, s));
    if (hit) errs.push(`${label}: ${which} ${t} is inside ${hit[0]}–${hit[1]} (speech or a response wait)`);
  };
  const rateOf = (x) => (x.rate ?? x.playbackRate ?? 1);
  if (cut.opener) {
    check('opener', 'start', cut.opener.src[0]);
    check('opener', 'end', cut.opener.src[1], true);
    if (rateOf(cut.opener) !== 1) errs.push('opener: playback rate must be 1');
  }
  let prevEnd = -Infinity;
  for (const b of cut.beats ?? []) {
    if (rateOf(b) !== 1) errs.push(`${b.id}: playback rate must be 1 (got ${rateOf(b)})`);
    if (!(b.src[1] > b.src[0])) errs.push(`${b.id}: end before start`);
    if (b.src[0] < prevEnd) errs.push(`${b.id}: overlaps the previous beat or is out of order`);
    prevEnd = b.src[1];
    check(b.id, 'start', b.src[0]);
    check(b.id, 'end', b.src[1], !!b.trim);
  }
  return errs;
}
