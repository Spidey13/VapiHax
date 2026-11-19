// Replays a recorded session through the app's own view code, so the film shows exactly what the app drew.
//
// The app animates with CSS and timers; a film frame must be a pure function of time. So the replay runs the
// app code on a virtual clock (setTimeout and requestAnimationFrame are swapped for virtual ones only while
// app code runs), forces a style flush after each step so CSS transitions start the way they
// do in a browser, pauses every animation the app starts, and finally seeks each one to the time elapsed since
// it started.
// (performance.now is read-only while rendering, so the endpointing glow uses arc.js's arcProgress directly,
// the same math createArc paints with.)
//
// The order of operations mirrors public/app.js (ingest, captions, speech, hold, end) and render.js play().

import { MARKUP } from '../app/markup.js';
import { createView } from '../app/js/render.js';
import { detectTransition, isInformational } from '../app/js/transitions.js';
import { arcProgress } from '../app/js/arc.js';
import { playRecap, playCompare } from '../app/js/commands.js';
import { renderEnding, renderEndPage } from '../app/js/endPage.js';

const STRUCTURAL = new Set(['fork', 'correction', 'merge']);
const ENDPOINTING_WAIT_MS = 2600; // /api/config endpointing.waitMs (0.6 s + 2.0 s, src/vapi/assistantConfig.ts)

/**
 * @param {HTMLElement} host where the app's markup goes (inside the camera)
 * @param {{ events: any[] }} session events in seconds of the recording
 */
export function createReplay(host, session) {
  const events = [...session.events].sort((a, b) => a.t - b.t);
  let w; // the world: everything that a rebuild resets

  // ---- the virtual clock ----
  function clock() {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    return {
      get now() { return now; },
      set(t) { now = t; },
      add(fn, ms) { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, id }); return id; },
      clear(id) { timers.delete(id); },
      next(limit) {
        let best = null;
        for (const x of timers.values()) if (x.at <= limit && (!best || x.at < best.at || (x.at === best.at && x.id < best.id))) best = x;
        if (best) timers.delete(best.id);
        return best;
      },
    };
  }

  /** Run app code with the virtual timers in place of the real ones. */
  function inApp(fn) {
    const saved = [window.setTimeout, window.clearTimeout, window.requestAnimationFrame, window.cancelAnimationFrame];
    const c = w.clock;
    window.setTimeout = (f, ms) => c.add(f, ms);
    window.clearTimeout = (id) => c.clear(id);
    window.requestAnimationFrame = (f) => c.add(() => f(c.now), 16);
    window.cancelAnimationFrame = (id) => c.clear(id);
    try { fn(); } finally {
      [window.setTimeout, window.clearTimeout, window.requestAnimationFrame, window.cancelAnimationFrame] = saved;
    }
  }

  const body = document.body;
  const $ = (id) => document.getElementById(id);

  // createView adds listeners to the window and to media queries (resize, phone layout, scroll). The replay
  // builds a new view every frame, so those listeners are removed with the old view, or each one would keep
  // its whole page alive and the render tab would run out of memory.
  let tracked = [];
  function withListenersTracked(fn) {
    for (const [target, type, f, o] of tracked) target.removeEventListener(type, f, o);
    tracked = [];
    const winAdd = window.addEventListener;
    const mqlAdd = MediaQueryList.prototype.addEventListener;
    window.addEventListener = function (type, f, o) { tracked.push([window, type, f, o]); return winAdd.call(window, type, f, o); };
    MediaQueryList.prototype.addEventListener = function (type, f, o) { tracked.push([this, type, f, o]); return mqlAdd.call(this, type, f, o); };
    try { return fn(); } finally {
      window.addEventListener = winAdd;
      MediaQueryList.prototype.addEventListener = mqlAdd;
    }
  }

  function rebuild() {
    for (const a of host.getAnimations({ subtree: true })) a.cancel();
    host.innerHTML = MARKUP;
    for (const c of ['listening', 'voice-off', 'held', 'user-speaking', 'assistant-speaking', 'gathering', 'chrome-hidden', 'emphasis', 'scroll', 'map-open']) body.classList.remove(c);
    body.style.removeProperty('--cur-h');
    body.style.removeProperty('--gather');
    w = { clock: clock(), i: 0, t: -Infinity, latest: null, pending: [], who: null, held: false, started: new WeakMap(), ended: false };
    inApp(() => {
      $('session-view').hidden = false;
      // A voice session in progress with the pointer at rest: the app's chrome is resting (public/app.js wake()).
      body.classList.add('listening', 'chrome-hidden');
      $('hint').textContent = 'Hold space to keep talking';
      w.view = withListenersTracked(() => createView({ onSwitch: () => {}, onOpenMap: () => {}, onSheetSwitch: () => {} }));
    });
    // createArc's behavior (voice.js): start() fills over the wait and gives up 1.5 s after it; reset() empties.
    let stoppedAt = null;
    let giveUp = 0;
    w.arc = {
      start() { stoppedAt = w.clock.now; w.clock.clear(giveUp); giveUp = w.clock.add(() => w.arc.reset(), ENDPOINTING_WAIT_MS + 1500); },
      reset() { stoppedAt = null; w.clock.clear(giveUp); },
      paint() {
        // public/app.js gatherSink: the arc's progress becomes --gather and .gathering on the page
        const p = arcProgress(w.clock.now, stoppedAt, ENDPOINTING_WAIT_MS);
        body.style.setProperty('--gather', p.toFixed(3));
        body.classList.toggle('gathering', p > 0.03);
      },
    };
    settle();
  }

  /** Flush styles so transitions start, then pause every new animation and note when it began. */
  function settle(startedAt = w.clock.now) {
    void host.offsetWidth;
    void getComputedStyle(body).getPropertyValue('--cur-h');
    for (const a of document.getAnimations()) {
      if (w.started.has(a) || !inHost(a)) continue;
      // The glow's 0.35 s smoothing of the endpointing arc (style.css .glow scale) follows a value the app
      // repaints every frame; here the value is painted once per film frame, so it lands at once.
      if (a.transitionProperty === 'scale' && a.effect.target.classList?.contains('glow')) { a.finish(); continue; }
      w.started.set(a, startedAt);
      a.pause();
    }
  }
  const inHost = (a) => {
    const el = a.effect?.target;
    return !!el && (host.contains(el) || el === body);
  };

  // ---- the app's behavior, step by step ----
  const forkPending = () => w.pending.some((k) => STRUCTURAL.has(k));

  function setSpeaking(who) {
    body.classList.toggle('assistant-speaking', who === 'assistant');
    body.classList.toggle('user-speaking', who === 'user');
  }

  function onState(next) {
    const prev = w.latest;
    if (prev && prev.sessionId === next.sessionId && next.revision < prev.revision) return;
    w.latest = next;
    if (!prev) { w.view.renderStructure(next, { animate: true }); return; }
    const t = detectTransition(prev, next);
    if (t.kind !== 'none') {
      w.pending = w.pending.filter((k) => k !== t.kind);
      if (!isInformational(t)) w.pending.push(t.kind);
      w.view.renderLive(next, forkPending());
    } else {
      w.view.renderLive(next, forkPending());
    }
  }

  /** render.js play(), with its waits on the virtual clock. */
  function onPlay(kind) {
    const state = w.latest;
    const view = w.view;
    w.pending = w.pending.filter((k) => k !== kind);
    if (!state) return;
    if (view.shownId === null) { view.renderStructure(state); return; }
    if (kind === 'recap') { view.renderStructure(state); playRecap(view.map, state); return; }
    if (kind === 'compare') { view.renderStructure(state); playCompare(view.map, state, state.lastDecision?.op?.otherId ?? null); return; }
    if (kind === 'refresh') { view.renderStructure(state); return; }
    const t = { kind };
    if (kind === 'switch' || kind === 'park') {
      const tr = $('transcript');
      tr.classList.add('swap-out');
      view.renderHeader(state, true, t);
      setTimeout(() => { view.renderText(state); tr.classList.remove('swap-out'); }, 160);
      return;
    }
    view.renderStructure(state, { animate: true, keepRows: kind !== 'merge', t });
  }

  function onSpeech(e) {
    const role = e.role === 'assistant' ? 'assistant' : 'user';
    if (e.status === 'started') { w.who = role; setSpeaking(role); w.arc.reset(); }
    else if (e.status === 'stopped') {
      if (w.who === role) { w.who = null; setSpeaking(null); }
      if (role === 'user' && w.who !== 'assistant' && !w.held) w.arc.start();
    }
  }

  function onEnd() {
    w.ended = true;
    body.classList.remove('chrome-hidden', 'listening', 'voice-off', 'held', 'user-speaking', 'assistant-speaking', 'gathering');
    w.arc.reset();
    $('session-view').hidden = true;
    body.classList.add('scroll');
    w.view.map.clear();
    w.view.sheetMap.clear();
    const endView = $('end-view');
    endView.hidden = false;
    renderEnding(endView);
  }

  function onShare(data) {
    // shareUrl only decides whether the "Copy link" button is drawn; the URL itself is never shown.
    renderEndPage($('end-view'), data, { shareUrl: 'https://example.invalid/s/x', currentId: w.latest?.currentBranchId, onRestart: () => {} });
  }

  function apply(e) {
    switch (e.type) {
      case 'state': onState(e.state); break;
      case 'play': if (e.phase === 'start') onPlay(e.kind); break;
      case 'transcript': if (!w.ended) w.view.setCaption({ role: e.role, text: e.text, final: e.final }, w.latest, forkPending()); break;
      case 'speech': if (!w.ended) onSpeech(e); break;
      case 'hold':
        w.held = !!e.on;
        body.classList.toggle('held', w.held);
        $('hint').textContent = w.held ? 'Release to get a reply' : 'Hold space to keep talking';
        if (w.held) w.arc.reset();
        break;
      case 'end': onEnd(); break;
      case 'share': onShare(e.data); break;
      default: break;
    }
  }

  /** Seek every animation the app started to virtual time `now`, as a browser would have it at that moment. */
  function seekAll(now) {
    for (const a of document.getAnimations()) {
      const s = w.started.get(a);
      if (s !== undefined) a.currentTime = Math.max(0, now - s);
    }
  }

  /**
   * Advance the world to session time `t` (seconds), running events and due timers in time order. Before each
   * step the running animations are brought to that moment, so a transition that starts mid-way through another
   * starts from the value on screen then. That makes a frame the same whether it was reached in one jump or
   * frame by frame (renders draw frames out of order, in several tabs).
   */
  // Every animation and timer the app starts is over within this long (the longest is the 3 s compare), so the
  // style work (flushes, seeks) is skipped for steps further back than this before the frame.
  const SETTLED_MS = 6000;

  function advance(t) {
    const limit = t * 1000;
    const fastUntil = limit - SETTLED_MS;
    let fast = fastUntil > 0;
    inApp(() => {
      for (;;) {
        const e = events[w.i];
        const eAt = e ? e.t * 1000 : Infinity;
        const timer = w.clock.next(Math.min(limit, eAt - 1e-6));
        const at = timer ? timer.at : e && eAt <= limit ? eAt : null;
        if (at === null) break;
        if (fast && at >= fastUntil) {
          // Everything started before here has finished by the frame: one flush, and whatever animations it
          // starts count as started at 0 (finished, or the glow's endless breathing in its true phase).
          fast = false;
          settle(0);
        }
        w.clock.set(at);
        if (!fast) seekAll(at);
        if (timer) timer.fn(); else { w.i++; apply(e); }
        if (!fast) settle();
      }
      if (fast) settle(0);
      w.clock.set(limit);
      settle();
    });
    w.t = t;
  }

  /**
   * Draw the app as it was at session time `t` (seconds).
   * Every frame replays the session from the start, so a frame never depends on the one drawn before it
   * (renders draw frames out of order, in several tabs). Then every animation the app started is brought to
   * time t and its values are pinned on the element: Chrome runs opacity, transform and colour animations on
   * its compositor thread, which does not pick up a seek on a paused animation, so the frame would lag.
   */
  function renderAt(t) {
    rebuild();
    advance(t);
    w.arc.paint();
    settle();
    seekAll(w.clock.now);
    const pins = [];
    for (const a of document.getAnimations()) {
      if (!w.started.has(a) || a.effect?.pseudoElement) continue; // stems (::before) stay seeked: top/height run on the main thread
      const el = a.effect?.target;
      if (!el) continue;
      const props = a.transitionProperty ? [a.transitionProperty]
        : [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)).filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)))]
          .map((k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
      const cs = getComputedStyle(el);
      pins.push({ el, values: props.map((p) => [p, cs.getPropertyValue(p)]) });
      a.cancel();
    }
    for (const { el, values } of pins) {
      el.style.setProperty('transition', 'none', 'important');
      el.style.setProperty('animation', 'none', 'important');
      for (const [p, v] of values) el.style.setProperty(p, v, 'important');
    }
  }

  /** Undo what the replay did to the page outside its host (body classes and properties). */
  function dispose() {
    for (const [target, type, f, o] of tracked) target.removeEventListener(type, f, o);
    tracked = [];
    for (const a of host.getAnimations({ subtree: true })) a.cancel();
    host.replaceChildren();
    for (const c of ['listening', 'voice-off', 'held', 'user-speaking', 'assistant-speaking', 'gathering', 'chrome-hidden', 'emphasis', 'scroll', 'map-open']) body.classList.remove(c);
    body.style.removeProperty('--cur-h');
    body.style.removeProperty('--gather');
  }

  rebuild();
  return { renderAt, dispose, get latest() { return w.latest; } };
}
