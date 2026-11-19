import { playRecap, playCompare } from './commands.js';
import { emptyCaptions, addFinal, setPartial, clearLive, pendingPath, speechEvent, setGate, openReplies, markSeen, playbackEvent, transcriptRows, syncCaptionPath } from './captions.js';
import { createBranchMap } from './branchMapView.js';
import { hueFor, PHONE_QUERY } from './branchMap.js';

const $ = (id) => document.getElementById(id);
const LINE_MAX = 90;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Renders stateView into the page. Text goes in via textContent only.
 * Transcript text updates live; the glow and the branch map change only in
 * `renderStructure`, which the animation queue calls between turns.
 * On phones the top-left map is compact and opens a sheet that lists every branch with its last line.
 * @param {{ onSwitch: (branchId: string) => void, onOpenMap?: () => void, onSheetSwitch?: (branchId: string) => void }} opts
 */
export function createView({ onSwitch, onOpenMap = () => {}, onSheetSwitch = onSwitch }) {
  const transcript = $('transcript');
  const glow = $('field').querySelector('.core');
  const wash = $('field').querySelector('.amb');
  const phone = window.matchMedia(PHONE_QUERY);
  const map = createBranchMap($('branchmap'), { onSwitch, compact: () => phone.matches, onOpen: onOpenMap });
  const sheetMap = createBranchMap($('sheet-map'), { onSwitch: onSheetSwitch, measure: true });
  phone.addEventListener('change', () => map.redraw());

  let shownSheetId = null; // the thread whose text is on screen
  let caps = emptyCaptions(); // display-only lines the server has not recorded yet
  let lastPath = []; // the turns last drawn (server turns only)
  let stick = true; // auto-scroll unless the user scrolled up
  /** @type {HTMLElement[]} */
  let rows = [];

  /** The glow and the ambient wash take the current thread's hue (they cross-fade via CSS). */
  function setHue(hue) {
    document.body.style.setProperty('--cur-h', hue);
    glow.style.backgroundColor = `hsl(${hue})`;
    wash.style.backgroundColor = `hsl(${hue} / .35)`;
  }

  const updateOverflow = () => transcript.classList.toggle('overflowing', transcript.scrollHeight > transcript.clientHeight + 2);
  transcript.addEventListener('scroll', () => {
    stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  }, { passive: true });
  window.addEventListener('resize', updateOverflow);

  function paintRow(row, role, text, corrected, live) {
    row.className = `${role === 'user' ? 'u' : 'a'}${live ? ' live' : ''}`;
    // Partial captions are not announced; the committed turn is.
    if (live) row.setAttribute('aria-live', 'off'); else row.removeAttribute('aria-live');
    row.replaceChildren();
    if (corrected) row.append(el('span', 'corrected', 'corrected'));
    row.append(document.createTextNode(text));
  }

  /** Live part: the turns of the thread currently on screen (+ the caption line). */
  function renderTranscript(path) {
    caps = syncCaptionPath(caps, path);
    lastPath = path;
    const items = transcriptRows(caps, path, Date.now()); // the clock only paces a reply under way (captions.js)
    if (!items.length) {
      rows = [];
      transcript.replaceChildren(el('p', 'empty', 'Say something to begin.'));
      return;
    }
    if (!rows.length) transcript.replaceChildren();
    items.forEach((it, i) => {
      if (!rows[i]) {
        rows[i] = el('p');
        transcript.append(rows[i]);
      }
      const sig = `${it.role}|${it.corrected}|${it.live}|${it.text}`;
      if (rows[i].dataset.sig !== sig) {
        rows[i].dataset.sig = sig;
        paintRow(rows[i], it.role, it.text, it.corrected, it.live);
      }
    });
    while (rows.length > items.length) rows.pop().remove();
    // The latest exchange (the last user line and whatever follows) is large; everything before it is the faded past.
    const lastUser = items.map((it) => it.role).lastIndexOf('user');
    rows.forEach((r, i) => {
      r.classList.toggle('old', i < Math.max(0, lastUser));
      r.classList.toggle('older', i < lastUser - 1); // only the line just before the exchange stays readable
    });
    updateOverflow();
    if (stick) transcript.scrollTop = transcript.scrollHeight;
  }

  /** Trim to LINE_MAX at a word boundary and mark the cut, so a line never ends mid-word. */
  const clipLine = (text) => {
    const chars = Array.from(String(text ?? '').trim());
    if (chars.length < LINE_MAX) return chars.join('');
    const cut = chars.slice(0, LINE_MAX - 1).join('');
    const sp = cut.lastIndexOf(' ');
    return `${(sp > LINE_MAX * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
  };
  const linesOf = (state) => {
    const cur = state.sheets.current;
    const out = { [cur.id]: clipLine(cur.path.at(-1)?.text) };
    for (const x of [...(state.sheets.others ?? []), ...(state.sheets.parked ?? [])]) out[x.id] = clipLine(x.lastLine);
    return out;
  };

  /** Glow hue and the branch map. Returns a promise that settles when the motion ends. */
  function renderHeader(state, animate, t = null) {
    const cur = state.sheets.current;
    setHue(hueFor(state.branches, cur.id));
    const lines = linesOf(state);
    sheetMap.show(state.branches, cur.id, { lines });
    sheetMap.emphasize('all', { persist: true });
    return map.show(state.branches, cur.id, { animate, kind: t?.kind ?? null, lines });
  }

  /** The transcript for the current thread; `keepRows` when the new thread continues the one on screen (a fork). */
  function renderText(state, keepRows = false, fresh = keepRows) {
    const cur = state.sheets.current;
    if (cur.id !== shownSheetId) {
      shownSheetId = cur.id;
      if (!keepRows) {
        rows = [];
        transcript.replaceChildren();
      }
      stick = true;
      // Turns already on a thread we arrive at were not spoken just now: only a fork or merge brings a reply being spoken.
      if (!fresh) caps = markSeen(caps, cur.path);
    }
    renderTranscript(cur.path);
  }

  /**
   * Structural part: glow, branch map, transcript. Returns the motion promise.
   * @param {{ animate?: boolean, keepRows?: boolean, t?: any }} [o]
   */
  function renderStructure(state, { animate = false, keepRows = false, t = null } = {}) {
    const motion = renderHeader(state, animate, t);
    renderText(state, keepRows, keepRows || t?.kind === 'merge');
    return motion;
  }

  // While the reply is paced by time, redraw a few times a second so the caption keeps up with the voice.
  let ticker = 0;
  function tick(state) {
    clearInterval(ticker);
    ticker = 0;
    if (state && caps.speaking && caps.turnAt) ticker = setInterval(() => { if (!caps.speaking) { clearInterval(ticker); ticker = 0; } else renderTranscript(lastPath); }, 150);
  }

  /** Live-update only: keep the shown thread's text current without touching structure. */
  function renderLive(state, forkPending = false) {
    const cur = state.sheets.current;
    if (cur.id === shownSheetId) renderTranscript(cur.path);
    else if (forkPending && shownSheetId !== null) renderTranscript(pendingPath(lastPath, cur.path)); // no structural change yet
  }

  /** Plays one structural transition, showing `state` when it lands. */
  async function play(t, state) {
    if (shownSheetId === null) { renderStructure(state); return; }
    // Informational overlays: no structure change, shown (opacity only) even with reduced motion.
    if (t.kind === 'recap') { renderStructure(state); await playRecap(map, state); return; }
    if (t.kind === 'compare') { renderStructure(state); await playCompare(map, state, t.other); return; }
    if (t.kind === 'refresh') { renderStructure(state); return; }
    if (t.kind === 'switch' || t.kind === 'park') {
      if (reducedMotion()) { await renderStructure(state); return; }
      // The map and glow switch at once; the words cross-fade: 160 ms out, 240 ms in.
      transcript.classList.add('swap-out');
      const motion = renderHeader(state, true, t);
      await wait(160);
      renderText(state);
      transcript.classList.remove('swap-out');
      await Promise.all([motion, wait(240)]);
      return;
    }
    // fork, merge, correction, fade: the new thread continues the old path, so the text stays put.
    await renderStructure(state, { animate: true, keepRows: t.kind !== 'merge', t });
  }

  return {
    renderStructure,
    renderLive,
    play,
    // The steps of play(), for a caller that sequences them itself (the launch film replays a session frame by frame).
    renderHeader,
    renderText,
    get shownId() { return shownSheetId; },
    map,
    sheetMap,
    /**
     * Voice captions: a final persists until the server records a turn of that role; a partial
     * (or a typed turn in flight) only overwrites the trailing live row. null clears the live row.
     * @param {{ role: string, text: string, final?: boolean } | null} c
     */
    setCaption(c, state, forkPending = false) {
      if (!c) caps = clearLive(caps);
      else if (c.final) caps = addFinal(caps, c.role, c.text, lastPath);
      else caps = setPartial(caps, c.role, c.text, lastPath);
      if (state) renderLive(state, forkPending);
    },
    /** Vapi speech-update: the reply is shown as far as it is spoken; a user cutting in freezes what was heard. */
    speech(role, status, state, forkPending = false) {
      caps = speechEvent(caps, role, status, lastPath, Date.now());
      if (state) renderLive(state, forkPending);
      tick(state);
    },
    /** Vapi assistant.speechStarted: playback turn identity for the reply being spoken (not a word cursor). */
    playback(ev, state, forkPending = false) {
      caps = playbackEvent(caps, ev, Date.now());
      if (state) renderLive(state, forkPending);
      tick(state);
    },
    /** A voice call is live: fresh replies wait for their speech. Off: everything shows at once. */
    setVoice(live, state, forkPending = false) {
      caps = setGate(caps, live, lastPath);
      if (state) renderLive(state, forkPending);
    },
    /** The next reply is not spoken (a typed turn): show it at once. */
    showRepliesAtOnce() { caps = openReplies(caps); },
  };
}
