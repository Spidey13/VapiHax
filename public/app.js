import { detectTransition, isInformational } from './js/transitions.js';
import { AnimationQueue } from './js/queue.js';
import { swipeIntent, startsOnHeader } from './js/gestures.js';
import { createView } from './js/render.js';
import { createHold } from './js/hold.js';
import { createArc, createVoice } from './js/voice.js';
import { renderEndPage, renderEnding } from './js/endPage.js';
import { PHONE_QUERY } from './js/branchMap.js';
import { createFilmLog, downloadFilmLog, filmFlag } from './js/filmLog.js';

const $ = (id) => document.getElementById(id);
const coarse = window.matchMedia('(pointer: coarse)').matches;
const phone = window.matchMedia(PHONE_QUERY);

let session = null; // { id, token }
let latest = null; // newest stateView accepted
let dirty = false; // a structural change is waiting in the queue
let cfg = {}; // /api/config, kept so a tap on the orb can reconnect voice
// ?film=1: keep a timestamped record of what the screen did, for the launch film (docs/launch/recording-checklist.md)
const film = createFilmLog({ enabled: filmFlag(location.search) });

async function api(path, opts = {}) {
  const res = await fetch(`/api/sessions${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...opts.headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return res;
}

const showError = (msg) => { $('error').textContent = msg; };

// ---- view + animation queue ----
const view = createView({
  onSwitch: (id) => switchTo(id),
  onOpenMap: () => openSheet(),
  onSheetSwitch: (id) => { closeSheet(); switchTo(id); },
});
const queue = new AnimationQueue(async (t) => {
  const rev = latest?.revision;
  try {
    film.play('start', t.kind, rev);
    await view.play(t, latest);
  } finally {
    film.play('end', t.kind, rev);
    dirty = queue.pending.length > 0;
  }
});

const forkPending = () => queue.pending.some((p) => p.kind === 'fork' || p.kind === 'correction' || p.kind === 'merge');

/** Same branches, statuses and current thread; only names differ (a thread was just named in the background). */
const shape = (s) => JSON.stringify([s.sheets.current.id, s.branches.map((b) => [b.id, b.status, b.parentId])]);
const renameOnly = (prev, next) => shape(prev) === shape(next) && prev.branches.some((b, i) => b.name !== next.branches[i]?.name);

function ingest(next, userInitiated = false) {
  if (latest && latest.sessionId === next.sessionId && next.revision < latest.revision) return; // stale poll
  const prev = latest;
  latest = next;
  film.state(next);
  if (!prev) { view.renderStructure(next, { animate: true }); return; }
  const t = detectTransition(prev, next);
  if (t.kind !== 'none') {
    dirty = true;
    // A rename is drawn at once, even while the assistant speaks, so "New path" does not linger; never ahead of queued motion.
    const rename = t.kind === 'refresh' && !queue.pending.length && renameOnly(prev, next);
    queue.push(t, { now: userInitiated || isInformational(t) || rename });
    // Still waiting (someone is speaking): show the new turns on the old thread meanwhile.
    if (queue.pending.length) view.renderLive(next, forkPending());
  } else {
    view.renderLive(next, forkPending());
  }
}

async function refresh() {
  if (!session) return;
  try { ingest(await (await api(`/${session.id}`)).json()); } catch { /* transient poll errors are fine */ }
}

async function switchTo(branchId) { // user-initiated (click, key or swipe): animate at once, even over speech
  if (!session || branchId === latest?.sheets.current.id) return;
  try {
    showError('');
    ingest((await (await api(`/${session.id}/switch`, { method: 'POST', body: JSON.stringify({ branchId }) })).json()).state, true);
    if (!voice.isLive()) queue.setSpeaking(null);
  } catch {
    showError("Couldn't switch threads. Try again.");
  }
}

// ---- voice, arc, hold ----
// The endpointing wait is drawn as the glow gathering (smaller, brighter), not as a ring:
// createArc paints into this stand-in for its circle, and the progress becomes --gather on the page.
const GATHER_C = 2 * Math.PI;
const gatherSink = {
  getAttribute: () => '1',
  style: {
    set strokeDasharray(_v) { /* unused */ },
    set strokeDashoffset(v) {
      const p = Math.min(1, Math.max(0, 1 - Number(v) / GATHER_C));
      document.body.style.setProperty('--gather', p.toFixed(3));
      document.body.classList.toggle('gathering', p > 0.03);
    },
  },
};
const arc = createArc(gatherSink, 2600);
const voice = createVoice({
  api,
  sessionId: () => session.id,
  arc,
  isHeld: () => hold.active,
  setSpeaking: (who) => {
    document.body.classList.toggle('assistant-speaking', who === 'assistant');
    document.body.classList.toggle('user-speaking', who === 'user');
    queue.setSpeaking(who);
  },
  refresh,
  onCaption: (c) => view.setCaption(c, latest, forkPending()),
  onEvent: (m) => {
    if (m.type === 'speech-update') view.speech(m.role === 'assistant' ? 'assistant' : 'user', m.status, latest, forkPending());
    if (m.type === 'assistant.speechStarted') view.playback({ turn: m.turn, text: m.text, source: m.source }, latest, forkPending());
    if (!film.on) return;
    if (m.type === 'assistant.speechStarted') film.playback(m.turn, m.source, m.text);
    else if (m.type === 'speech-update') film.speech(m.role === 'assistant' ? 'assistant' : 'user', m.status);
    else if (m.type === 'transcript') film.transcript(m.role === 'assistant' ? 'assistant' : 'user', m.transcriptType !== 'partial', m.transcript);
  },
  onStatus: (t) => { $('voice-status').textContent = statusText(t); },
  onLive: (live) => {
    view.setVoice(live, latest, forkPending());
    if (!live) hold.release(false); // the mic is gone: end any hold without a reply trigger
    syncVoiceUi();
  },
});

const hintText = () => (coarse ? 'Press and hold the glow to keep talking' : 'Hold space to keep talking');

/** voice.js speaks in short status codes; the screen says it in plain words. */
function statusText(t) {
  if (/^(connecting|binding)/i.test(t)) return 'Connecting…';
  if (/^listening/i.test(t)) return 'Listening';
  if (/^Voice off/.test(t)) return coarse ? 'Voice off. Tap the glow to reconnect.' : 'Voice off. Click the glow to reconnect.';
  if (/^Voice is not configured/.test(t)) return "Voice isn't set up. Type below.";
  if (/^Voice error/.test(t)) return 'Voice had a problem. You can keep typing.';
  return t;
}

/** Hold needs a live call; in typed mode the hint and the end control are hidden. */
function syncVoiceUi() {
  const live = voice.isLive();
  $('hint').hidden = !live;
  $('btn-end').hidden = !live;
  $('orb').setAttribute('aria-label', live ? 'Hold to keep talking' : 'Reconnect voice');
  document.body.classList.toggle('listening', live);
  document.body.classList.toggle('voice-off', !live);
  if (!live) document.body.classList.remove('user-speaking', 'assistant-speaking', 'gathering');
}

$('orb').addEventListener('click', () => {
  if (!session || voice.isLive()) return;
  voice.start(cfg);
});
$('btn-end').addEventListener('click', (e) => {
  if (e.detail > 0) e.currentTarget.blur();
  voice.stop();
});

const hold = createHold({
  orb: $('orb'),
  post: async (h) => ingest((await (await api(`/${session.id}/hold`, { method: 'POST', body: JSON.stringify({ hold: h }) })).json()).state),
  enabled: () => session !== null && voice.isLive(),
  isLive: () => voice.isLive(),
  send: (msg) => voice.send(msg),
  onChange: (active) => {
    film.hold(active);
    $('orb').setAttribute('aria-pressed', String(active));
    document.body.classList.toggle('held', active);
    $('hint').textContent = active ? 'Release to get a reply' : hintText();
    if (active) arc.reset();
  },
  onError: () => showError("Hold didn't register. Try again."),
});

// ---- typed turns ----
$('turn-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('turn-input');
  const text = input.value.trim();
  if (!text || !session) return;
  input.value = '';
  showError('');
  view.showRepliesAtOnce(); // a typed turn's reply is not spoken
  view.setCaption({ role: 'user', text }, latest, forkPending());
  try {
    const r = await (await api(`/${session.id}/turn`, { method: 'POST', body: JSON.stringify({ text }) })).json();
    view.setCaption(null);
    ingest(r.state);
  } catch {
    view.setCaption(null, latest, forkPending());
    showError("That didn't go through. Try sending it again.");
  } finally {
    // No speech events without a call: let queued animations play once the reply is in.
    if (!voice.isLive()) queue.setSpeaking(null);
  }
};

$('btn-send').addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); });

// ---- swipe down on the transcript (touch) = back to the most recent other thread ----
{
  let start = null;
  const area = $('transcript');
  area.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    start = { y: t.clientY, at: performance.now(), header: startsOnHeader(e.target) };
  }, { passive: true });
  area.addEventListener('touchend', (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const intent = swipeIntent({ dy: t.clientY - start.y, dt: performance.now() - start.at, startedAtTop: start.header });
    start = null;
    const peekId = latest?.sheets.peek?.id;
    if (intent === 'switch-back' && peekId) switchTo(peekId);
  }, { passive: true });
  area.addEventListener('touchcancel', () => { start = null; }, { passive: true });
}

// ---- phone: the compact map opens a frosted sheet with every branch (voice keeps running underneath) ----
const sheet = $('map-sheet');
const sheetOpen = () => document.body.classList.contains('map-open');
function openSheet() {
  if (!session || !phone.matches || sheetOpen()) return;
  view.sheetMap.relayout(); // measure the stems now that the sheet is laid out
  sheet.inert = false;
  document.body.classList.add('map-open');
  view.map.setOpen(true);
  requestAnimationFrame(() => view.sheetMap.relayout());
  (sheet.querySelector('[aria-current]') ?? sheet.querySelector('button'))?.focus({ preventScroll: true });
}
function closeSheet({ restoreFocus = false } = {}) {
  if (!sheetOpen()) return;
  document.body.classList.remove('map-open');
  sheet.inert = true;
  view.map.setOpen(false);
  if (restoreFocus) document.querySelector('#branchmap .bm-open')?.focus();
  else if (sheet.contains(document.activeElement)) document.activeElement.blur();
}
$('map-scrim').addEventListener('click', () => closeSheet());
phone.addEventListener('change', () => { if (!phone.matches) closeSheet(); });
{
  let from = null;
  sheet.addEventListener('touchstart', (e) => { from = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (!from) return;
    const t = e.changedTouches[0];
    const dy = t.clientY - from.y;
    const dx = t.clientX - from.x;
    from = null;
    const atEnd = sheet.scrollTop + sheet.clientHeight >= sheet.scrollHeight - 2;
    if (dy < -40 && Math.abs(dy) > Math.abs(dx) * 1.5 && atEnd) closeSheet();
  }, { passive: true });
  sheet.addEventListener('touchcancel', () => { from = null; }, { passive: true });
}
const finishLabel = () => { $('btn-finish').textContent = phone.matches ? 'End' : 'End session'; };
finishLabel();
phone.addEventListener('change', finishLabel);

// ---- chrome: input and buttons appear with the pointer and rest after a pause ----
const IDLE_MS = 2500;
let idleTimer = 0;
function wake() {
  document.body.classList.remove('chrome-hidden');
  clearTimeout(idleTimer);
  if (coarse || !session) return;
  idleTimer = setTimeout(() => { if (session) document.body.classList.add('chrome-hidden'); }, IDLE_MS);
}
for (const ev of ['pointermove', 'pointerdown', 'keydown', 'focusin']) document.addEventListener(ev, wake, { passive: true });

const isTextField = (n) => !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable);
document.addEventListener('keydown', (e) => {
  if (!session) return;
  if (e.key === 'Escape' && sheetOpen()) { e.preventDefault(); closeSheet({ restoreFocus: true }); return; }
  if (e.key === 'Escape' && document.activeElement === $('turn-input')) { $('turn-input').blur(); return; }
  if (e.key === '/' && !e.altKey && !e.ctrlKey && !e.metaKey && !isTextField(document.activeElement)) {
    e.preventDefault();
    $('turn-input').focus();
    return;
  }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && latest) {
    const sh = latest.sheets;
    const ids = [sh.current.id, ...(sh.others ?? []).map((o) => o.id), ...(sh.parked ?? []).map((p) => p.id)];
    if (ids.length < 2) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    switchTo(ids[(ids.indexOf(sh.current.id) + step + ids.length) % ids.length]);
  }
});

function countSession() {
  try {
    const n = (Number(localStorage.getItem('bv.sessions')) || 0) + 1;
    localStorage.setItem('bv.sessions', String(n));
    return n;
  } catch { return 1; }
}

// ---- end session: stops voice, asks the server for the summary, swaps the session view for the end screen ----
$('btn-finish').addEventListener('click', async (e) => {
  if (!session) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  showError('');
  closeSheet();
  try { voice.stop(); } catch { /* already stopped */ }
  film.end();
  const endView = $('end-view');
  $('session-view').hidden = true;
  document.body.classList.remove('chrome-hidden');
  document.body.classList.add('scroll');
  view.map.clear();
  view.sheetMap.clear();
  document.body.classList.remove('listening', 'voice-off', 'held', 'user-speaking', 'assistant-speaking', 'gathering');
  endView.hidden = false;
  renderEnding(endView);
  let r;
  try {
    r = await (await api(`/${session.id}/end`, { method: 'POST' })).json();
  } catch { // /end itself failed: the session is still live
    endView.hidden = true;
    $('session-view').hidden = false;
    document.body.classList.remove('scroll');
    if (latest) view.renderStructure(latest); // the map was cleared for the end screen
    syncVoiceUi();
    btn.disabled = false;
    showError("Couldn't end the session. Try again.");
    return;
  }
  const opts = { shareUrl: r.shareUrl, currentId: latest?.currentBranchId, onRestart: () => location.reload() };
  const shareId = String(r.shareUrl || '').split('/').filter(Boolean).pop() || '';
  const loadShare = async () => {
    const res = await fetch(`/api/share/${encodeURIComponent(shareId)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  };
  try {
    let data;
    try { data = await loadShare(); } catch { data = await loadShare(); } // one retry
    renderEndPage(endView, data, opts);
    if (film.on) {
      film.share(data);
      setTimeout(() => downloadFilmLog(film), 4000); // after the end screen has been on camera for a moment
    }
  } catch { // the session has ended (turns would 409), so stay on the end view
    renderEndPage(endView, { nothing: true, summary: null, branches: [], map: null, showMap: false }, { ...opts, failed: true });
  }
  endView.querySelector('h1')?.setAttribute('tabindex', '-1');
  endView.querySelector('h1')?.focus();
});

// ---- debug latency command (only with ?debug=1; never logged) ----
function showDebugCommand() {
  let on = false;
  try { on = new URLSearchParams(location.search).get('debug') === '1'; } catch { /* no flag */ }
  if (!on || !session) return;
  const text = `npm run latency -- ${session.id} ${session.token}`;
  const el = document.createElement('p');
  el.id = 'debug-cmd';
  el.className = 'debug-cmd';
  el.title = 'Click to copy';
  el.textContent = text;
  el.onclick = async () => {
    try { await navigator.clipboard.writeText(text); } catch { /* selection still works */ }
  };
  document.querySelector('.dock').appendChild(el);
}

// ---- start ----
// The mint glow behind the frost brightens when the button is hovered or focused.
$('btn-start').addEventListener('pointerenter', () => $('field').classList.add('lit'));
$('btn-start').addEventListener('pointerleave', () => $('field').classList.remove('lit'));
$('btn-start').addEventListener('focus', () => $('field').classList.add('lit'));
$('btn-start').addEventListener('blur', () => $('field').classList.remove('lit'));

$('btn-start').onclick = async () => {
  const btn = $('btn-start');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  $('start-error').textContent = '';
  try {
    const r = await (await fetch('/api/sessions', { method: 'POST' })).json();
    session = { id: r.sessionId, token: r.token };
    $('field').classList.remove('lit');
    $('start-screen').hidden = true;
    $('session-view').hidden = false;
    document.body.classList.add('voice-off');
    $('hint').textContent = hintText();
    $('hint').classList.toggle('keep', countSession() <= 3);
    $('orb').title = 'Hold space or press and hold to talk. / types, Esc leaves the box, Alt+Up and Alt+Down switch threads.';
    wake();
    showDebugCommand();
    syncVoiceUi();
    ingest(r.state);
  } catch {
    btn.disabled = false;
    btn.textContent = 'Start talking';
    $('start-error').textContent = "Couldn't start. Check your connection and try again.";
    return;
  }
  try { cfg = await (await fetch('/api/config')).json(); } catch { /* typed mode still works */ }
  if (cfg.endpointing?.waitMs) arc.setWait(cfg.endpointing.waitMs);
  await voice.start(cfg);
  syncVoiceUi();
};
