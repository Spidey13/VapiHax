import { arcProgress } from './arc.js';

const OFF = 'Voice off — tap the orb to reconnect';
const VAPI_WEB = 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@3.1.0/+esm';

/**
 * The Vapi class from the CDN module. jsDelivr's ESM build of this CommonJS package has served the class as
 * `default` and, since, as `default.default`; take whichever is the constructor.
 * @param {any} m the imported module
 */
export function vapiClass(m) {
  for (const c of [m?.default, m?.default?.default, m]) if (typeof c === 'function') return c;
  throw new Error('the Vapi web SDK module has no constructor');
}

/**
 * The endpointing arc around the orb: fills while the user pauses, resets when they speak.
 * @param {SVGCircleElement} circle
 * @param {number} waitMs
 */
export function createArc(circle, waitMs) {
  const r = Number(circle.getAttribute('r'));
  const c = 2 * Math.PI * r;
  circle.style.strokeDasharray = String(c);
  circle.style.strokeDashoffset = String(c);
  let stoppedAt = null;
  let raf = 0;
  let giveUp = 0;
  const paint = () => {
    const p = arcProgress(performance.now(), stoppedAt, waitMs);
    circle.style.strokeDashoffset = String(c * (1 - p));
    raf = stoppedAt == null || p >= 1 ? 0 : requestAnimationFrame(paint);
  };
  return {
    setWait(ms) { waitMs = ms; },
    /** The user went quiet: start filling. */
    start() {
      stoppedAt = performance.now();
      if (!raf) raf = requestAnimationFrame(paint);
      // Still full and no reply began: the turn never came (dropped or held). Empty the arc.
      clearTimeout(giveUp);
      giveUp = setTimeout(() => this.reset(), waitMs + 1500);
    },
    /** Speech resumed, hold pressed, or the assistant took over: empty the arc. */
    reset() { stoppedAt = null; clearTimeout(giveUp); cancelAnimationFrame(raf); raf = 0; paint(); },
  };
}

/**
 * Vapi call lifecycle, captions, and speech-update -> queue/arc wiring.
 * @param {{
 *   api: (path: string, opts?: object) => Promise<Response>,
 *   sessionId: () => string,
 *   arc: ReturnType<typeof createArc>,
 *   isHeld: () => boolean,
 *   setSpeaking: (who: 'user' | 'assistant' | null) => void,
 *   refresh: () => Promise<void>,
 *   onCaption: (c: { role: string, text: string, final: boolean } | null) => void,
 *   onStatus: (text: string) => void,
 *   onLive?: (live: boolean) => void,
 *   onEvent?: (m: any) => void,
 * }} o
 *   onEvent sees every Vapi client message first (the film log uses it).
 */
export function createVoice({ api, sessionId, arc, isHeld, setSpeaking, refresh, onCaption, onStatus, onLive = () => {}, onEvent = () => {}, loadVapi = () => import(VAPI_WEB).then(vapiClass) }) {
  let vapi = null;
  let gen = 0; // bumped by stop(): a start that began earlier must not go live
  let connecting = false;
  let pollTimer = null;
  let who = null;

  function onSpeech(m) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (m.status === 'started') {
      who = role;
      setSpeaking(role);
      arc.reset();
    } else {
      if (who === role) { who = null; setSpeaking(null); }
      if (role === 'user' && who !== 'assistant' && !isHeld()) arc.start();
    }
    refresh();
  }

  function onMessage(m) {
    try { onEvent(m); } catch { /* a logger must never break voice */ }
    if (m.type === 'transcript') {
      const final = m.transcriptType !== 'partial';
      // Finals stay on screen until the server records a turn of that role (the view prunes them).
      onCaption({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.transcript, final });
      if (final) refresh();
    } else if (m.type === 'speech-update') {
      onSpeech(m);
    }
  }

  async function start(cfg) {
    if (!cfg.vapiPublicKey || !cfg.assistantId) {
      onStatus('Voice is not configured; type your turns below.');
      return false;
    }
    if (vapi || connecting) return true; // already connected or connecting
    const my = gen;
    connecting = true;
    onStatus('connecting…');
    let inst = null;
    try {
      const Vapi = await loadVapi();
      if (my !== gen) return false; // stopped while the library loaded
      inst = new Vapi(cfg.vapiPublicKey);
      const mine = inst;
      vapi = mine;
      onLive(true);
      mine.on('message', (m) => { if (vapi === mine) onMessage(m); });
      mine.on('error', (e) => { if (vapi === mine) onStatus(`Voice error: ${e?.message ?? e?.error?.message ?? 'see console'}. You can keep typing.`); });
      mine.on('call-end', () => { if (vapi === mine) { stop(true); onStatus(OFF); } });
      const call = await mine.start(cfg.assistantId);
      if (my !== gen) { try { mine.stop(); } catch { /* ignore */ } return false; }
      if (!call?.id) throw new Error('no call id returned from start()');
      try { mine.setMuted(true); } catch { /* ignore */ }
      onStatus('binding…');
      await api(`/${sessionId()}/bind`, { method: 'POST', body: JSON.stringify({ callId: call.id }) });
      if (my !== gen) { try { mine.stop(); } catch { /* ignore */ } return false; }
      try { mine.setMuted(false); } catch { /* ignore */ }
      onStatus('listening');
      pollTimer = setInterval(refresh, 1000);
      return true;
    } catch (e) {
      if (my !== gen) { try { inst?.stop(); } catch { /* ignore */ } return false; }
      console.error('voice start failed', e);
      stop(true);
      onStatus(OFF);
      return false;
    } finally {
      if (my === gen) connecting = false;
    }
  }

  function stop(keepStatus = false) {
    gen++;
    connecting = false;
    try { vapi?.stop(); } catch { /* ignore */ }
    vapi = null;
    who = null;
    clearInterval(pollTimer);
    setSpeaking(null);
    arc.reset();
    onLive(false);
    if (!keepStatus) onStatus(OFF);
  }

  return {
    start,
    stop,
    isLive: () => vapi !== null,
    send: (msg) => { try { vapi?.send(msg); } catch (e) { console.error(e); } },
  };
}
