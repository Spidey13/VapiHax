// Plans the film from a session and a cut: where each kept stretch of the session lands in film time, where
// the camera goes, when the text blocks and subtitles show. Pure: no DOM, no clock.

/** Structural animations the camera goes to the map for: how long the app's own animation runs, and when the
 *  text block comes in after it starts (seconds). Durations are the app's: style.css and commands.js. */
export const MAP_KINDS = {
  fork: { anim: 1.2, card: 0.55 },
  correction: { anim: 1.2, card: 0.55 },
  merge: { anim: 0.9, card: 0.6 },
  switch: { anim: 0.9, card: 0.35 },
  park: { anim: 0.9, card: 0.35 },
  compare: { anim: 3.0, card: 0.45 },
  recap: { anim: 2.5, card: 0.45 },
};
export const MOVE = 0.6; // a camera move
export const LEAD = 0.15; // the camera arrives this long before the app's animation starts
export const PUSH = 1.2; // the slower first push from wide to the words

/** How long a line must hold to be read: 0.5 s plus 0.3 s a word. */
export const readTime = (...texts) => 0.5 + 0.3 * texts.join(' ').split(/\s+/).filter(Boolean).length;

/**
 * @param {{ events: any[] }} session events in seconds of the recording
 * @param {{ opener?: { src: [number, number], zoom?: { at: number, scale?: number } }, title?: number,
 *   beats: { id: string, src: [number, number], frame?: 'words' | 'wide' | 'end', card?: { title: string, line: string } }[],
 *   numbers?: number, endCard?: number }} cut
 * @param {{ words?: { text: string, start: number, end: number }[] }} [o] word timings, seconds of the recording
 */
export function buildFilm(session, cut, { words = [] } = {}) {
  const events = [...session.events].sort((a, b) => a.t - b.t);
  let at = 0;
  const opener = cut.opener ? { at: 0, dur: cut.opener.src[1] - cut.opener.src[0], src: cut.opener.src, zoom: cut.opener.zoom ?? null } : null;
  if (opener) at += opener.dur;
  const title = { at, dur: cut.title ?? 2 };
  at += title.dur;
  const segments = cut.beats.map((b) => {
    const seg = { id: b.id, at, dur: b.src[1] - b.src[0], src: b.src, frame: b.frame ?? 'words', card: b.card ?? null };
    at += seg.dur;
    return seg;
  });
  const numbers = { at, dur: cut.numbers ?? 4 };
  at += numbers.dur;
  const endCard = { at, dur: cut.endCard ?? 3 };
  at += endCard.dur;
  const duration = Math.round(at * 1000) / 1000;

  const segOfSrc = (s) => segments.find((g) => s >= g.src[0] - 1e-6 && s <= g.src[1] + 1e-6);
  /** Film time of a session moment, or null if it was cut. */
  const toFilm = (s) => { const g = segOfSrc(s); return g ? g.at + (s - g.src[0]) : null; };
  /** The session moment on screen at film time t (held before the first and after the last kept stretch). */
  const srcAt = (t) => {
    if (!segments.length) return 0;
    if (t <= segments[0].at) return segments[0].src[0];
    for (const g of segments) if (t < g.at + g.dur) return g.src[0] + (t - g.at);
    const last = segments[segments.length - 1];
    return last.src[1];
  };

  // ---- the camera: one visit to the map per structural animation (close ones share a visit) ----
  const plays = events
    .filter((e) => e.type === 'play' && e.phase === 'start' && MAP_KINDS[e.kind])
    .map((e) => ({ ...e, film: toFilm(e.t), seg: segOfSrc(e.t) }))
    .filter((p) => p.film != null && p.seg.frame === 'words');
  const carded = new Set();
  const visits = [];
  for (const p of plays) {
    const k = MAP_KINDS[p.kind];
    let card = null;
    if (p.seg.card && !carded.has(p.seg.id)) {
      carded.add(p.seg.id);
      card = { ...p.seg.card, at: p.film + k.card, kind: p.kind, revision: p.revision };
    }
    const leave = Math.max(p.film + k.anim + 0.3, card ? card.at + readTime(card.title, card.line) : 0);
    const moveStart = p.film - LEAD - MOVE;
    const prev = visits[visits.length - 1];
    if (prev && moveStart < prev.leave + MOVE + 0.3) {
      prev.leave = Math.max(prev.leave, leave);
      prev.plays.push(p);
      if (card) prev.cards.push(card);
    } else {
      visits.push({ moveStart, arrive: p.film - LEAD, leave, back: 0, plays: [p], cards: card ? [card] : [] });
    }
  }
  for (const v of visits) v.back = v.leave + MOVE;

  /** Camera keyframes: from `at`, move to framing `to` over `dur`. */
  const shots = [];
  segments.forEach((g, i) => {
    if (i === 0) {
      shots.push({ at: g.at, dur: 0, to: g.frame === 'words' ? 'wide' : g.frame });
      if (g.frame === 'words') shots.push({ at: g.at + 1.0, dur: PUSH, to: 'words' });
    } else if (g.frame !== segments[i - 1].frame) shots.push({ at: g.at, dur: MOVE, to: g.frame });
  });
  for (const v of visits) {
    shots.push({ at: v.moveStart, dur: MOVE, to: 'map', kind: v.plays[0].kind });
    shots.push({ at: v.leave, dur: MOVE, to: 'words' });
  }
  shots.sort((a, b) => a.at - b.at);

  const cards = [];
  for (const v of visits) {
    v.cards.forEach((c, i) => {
      const end = i + 1 < v.cards.length ? v.cards[i + 1].at - 0.05 : v.leave;
      cards.push({ at: c.at, dur: Math.max(0.3, end - c.at), title: c.title, line: c.line, kind: c.kind, revision: c.revision });
    });
  }

  // ---- subtitles: only while the app's own transcript is out of frame ----
  const visible = visits.map((v) => [v.moveStart + 0.3, v.back - 0.2]);
  if (opener?.zoom) visible.push([opener.zoom.at - opener.src[0], opener.dur]);
  const subs = [];
  for (const g of groupWords(words, events)) {
    const a = opener && g.start >= opener.src[0] && g.end <= opener.src[1] ? g.start - opener.src[0] : toFilm(g.start);
    const b = opener && g.start >= opener.src[0] && g.end <= opener.src[1] ? g.end - opener.src[0] : toFilm(g.end);
    if (a == null || b == null || b < a) continue;
    for (const [va, vb] of visible) {
      const s = Math.max(a, va);
      const e = Math.min(Math.max(b, a + 1.2), vb);
      if (e - s >= 0.6) subs.push({ at: s, dur: e - s, role: g.role, text: g.text });
    }
  }
  subs.sort((x, y) => x.at - y.at);
  // hold each group long enough to read when the window allows, never into the next group
  for (let i = 0; i < subs.length; i++) {
    const win = visible.find(([va, vb]) => subs[i].at >= va - 1e-6 && subs[i].at < vb);
    const limit = Math.min(win ? win[1] : Infinity, i + 1 < subs.length ? subs[i + 1].at : Infinity);
    subs[i].dur = Math.max(0.3, Math.min(Math.max(subs[i].dur, readTime(subs[i].text)), limit - subs[i].at));
  }

  return { duration, opener, title, segments, numbers, endCard, toFilm, srcAt, visits, shots, cards, subs };
}

/** Words into subtitle groups of up to six, breaking at a sentence end, a 0.35 s pause or a change of speaker. */
export function groupWords(words, events) {
  const wins = events.filter((e) => e.type === 'speech').sort((a, b) => a.t - b.t);
  const roleAt = (t) => {
    let role = 'user';
    let best = Infinity;
    for (const e of wins) {
      const d = Math.abs(e.t - t);
      if (e.status === 'started' && e.t <= t + 0.3 && d < best) { best = d; role = e.role; }
    }
    return role;
  };
  const groups = [];
  let cur = null;
  for (const w of words) {
    const role = roleAt(w.start);
    const brk = !cur || cur.role !== role || cur.n >= 6 || w.start - cur.end >= 0.35 || /[.?!]$/.test(cur.text);
    if (brk) { cur = { role, text: w.text.trim(), start: w.start, end: w.end, n: 1 }; groups.push(cur); }
    else { cur.text += ` ${w.text.trim()}`; cur.end = w.end; cur.n++; }
  }
  return groups.map(({ n, ...g }) => g);
}
