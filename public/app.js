const $ = (id) => document.getElementById(id);
let session = null; // { id, token }

const OUTCOMES = {
  'next-check': 'Working toward the next check.',
  'user-reported-recovered': 'User-reported recovered (not verified).',
  unresolved: 'Unresolved. Download the packet to hand off.',
  unsupported: 'Unsupported by a documented capability boundary.',
  handoff: 'Handing off. Download the packet.',
};

async function api(path, opts = {}) {
  const res = await fetch(`/api/sessions${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...opts.headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return res;
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}

async function sendTurn(text) {
  const r = await (await api(`/${session.id}/turn`, { method: 'POST', body: JSON.stringify({ text }) })).json();
  $('reply').textContent = r.reply;
  if ($('chk-tts').checked && 'speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(r.reply));
  render(r.state);
}

function liveBox(L) {
  if (!L) return el('div', { className: 'live muted', textContent: 'Exa live check: off' });
  if (L.status === 'pending') return el('div', { className: 'live pending', textContent: 'Exa · checking official sources live…' });
  if (L.status === 'unavailable') return el('div', { className: 'live muted', textContent: 'Exa live refresh unavailable — curated source shown' });
  const t = new Date(L.results[0].fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return el('div', { className: 'live' },
    el('div', { className: 'live-head', textContent: `LIVE · Exa · fetched ${t} · ${L.ms} ms${L.startedFromPartial ? ' · started from a partial transcript, before you finished speaking' : ''}` }),
    ...L.results.map((r) => el('div', { className: 'live-item' },
      el('a', { href: r.url, target: '_blank', rel: 'noopener', textContent: r.title }),
      el('span', { className: 'sub', textContent: ` · published ${r.publishedDate ? r.publishedDate.slice(0, 10) : 'unknown'}` }),
      el('blockquote', { textContent: r.highlight }))),
    el('div', { className: 'sub', textContent: 'Supports the curated step above; it never rewrites the instruction.' }));
}

let livePoll = 0;
function render(s) {
  if (s.liveSources?.status === 'pending' && !livePoll) livePoll = setTimeout(async () => { livePoll = 0; try { const r = await (await api(`/${session.id}`)).json(); render(r); } catch {} }, 800);
  $('notices').replaceChildren(...s.notices.slice(-4).map((n) => el('div', { className: `notice ${n.kind}`, textContent: `${n.kind}: ${n.text}` })));

  const c = s.currentCheck;
  const box = $('check');
  if (!c) {
    box.className = 'card muted';
    box.textContent = s.pendingQuestion ? 'Waiting on your answer to the question above.' : 'No check right now.';
  } else {
    box.className = 'card';
    const links = c.sources.map((x) => el('a', { href: x.url, target: '_blank', rel: 'noopener', textContent: `${x.id} Â· ${x.publisher} (${x.mode} ${x.capturedAt})` }));
    const actions = c.terminal
      ? []
      : [
          ['Done â€“ worked', 'it worked', 'ok'],
          ['Done â€“ failed', 'I tried that and it failed', 'bad'],
          ["Haven't done it", "I haven't done that", 'neutral'],
        ].map(([label, text, cls]) => el('button', { className: cls, textContent: label, onclick: () => sendTurn(text) }));
    box.replaceChildren(
      el('p', {}, el('strong', { textContent: 'Do: ' }), c.actionText),
      el('p', {}, el('strong', { textContent: 'Expect: ' }), c.expectedObservation),
      el('p', {}, el('strong', { textContent: 'Stop if: ' }), c.stopConditions),
      el('div', {}, ...links),
      liveBox(s.liveSources),
      el('div', { className: 'actions' }, ...actions),
    );
  }

  $('attempts').replaceChildren(
    ...(s.attempts.length
      ? s.attempts.map((a) => el('li', { className: a.applicable ? '' : 'stale', textContent: `${a.checkId}: ${a.outcome}` }))
      : [el('li', { textContent: 'none yet' })]),
  );

  const table = $('facts');
  table.replaceChildren(
    ...Object.values(s.facts)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const input = el('input', { value: f.value ?? '', placeholder: 'unknown', size: 16 });
        input.addEventListener('change', async () => {
          try {
            const r = await (await api(`/${session.id}/facts`, { method: 'PATCH', body: JSON.stringify({ path: f.path, value: input.value.trim() || null }) })).json();
            $('reply').textContent = r.reply;
            render(r.state);
          } catch (e) {
            $('reply').textContent = `Edit failed: ${e.message}`;
          }
        });
        const tr = el('tr', { className: f.status === 'disputed' ? 'disputed' : '' });
        tr.append(
          el('td', { textContent: f.path }),
          el('td', { className: f.value === null ? 'unknown' : '' }, input),
          el('td', { textContent: f.status === 'disputed' ? `disputed (said: ${f.proposed})` : f.status }),
        );
        return tr;
      }),
  );

  $('outcome').textContent = `Outcome: ${OUTCOMES[s.outcome] ?? s.outcome}`;
}

async function download(kind) {
  const res = await api(`/${session.id}/packet.${kind}`);
  const url = URL.createObjectURL(await res.blob());
  const a = el('a', { href: url, download: `support-packet.${kind}` });
  a.click();
  URL.revokeObjectURL(url);
}

$('btn-start').onclick = async () => {
  const r = await (await fetch('/api/sessions', { method: 'POST' })).json();
  session = { id: r.sessionId, token: r.token };
  $('start').hidden = true;
  $('app').hidden = false;
  $('reply').textContent = 'Tell me what is happening, including which phone you are pairing with.';
  render(r.state);
};
$('turn-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('turn-input').value.trim();
  if (!text) return;
  $('turn-input').value = '';
  try {
    await sendTurn(text);
  } catch (err) {
    $('reply').textContent = `Something went wrong: ${err.message}`;
  }
};
$('btn-md').onclick = () => download('md');
$('btn-json').onclick = () => download('json');
$('btn-reset').onclick = async () => {
  const r = await (await api(`/${session.id}/reset`, { method: 'POST' })).json();
  $('reply').textContent = 'Case reset to the example fixture.';
  render(r.state);
};

// ---- Voice (Vapi web SDK) ----
const VAPI_WEB = 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@3.1.0/+esm';
let vapi = null;
let pollTimer = null;
const caps = []; // {role, text, partial}  display-only

function drawCaptions() {
  $('captions').replaceChildren(
    ...caps.slice(-8).map((c) => el('div', { style: c.partial ? 'color:#888' : '', textContent: `${c.role === 'user' ? 'You' : 'Relay'}: ${c.text}` })),
  );
}
async function refresh() {
  try {
    render(await (await api(`/${session.id}`)).json());
    const t = (await (await api(`/${session.id}/trace`)).json()).traces.slice(-3);
    $('trace').textContent = t.length
      ? t
          .map((x) => {
            const b = x.firstPartialAt ?? x.finalAt ?? x.llmRequestAt;
            const f = (k) => (x[k] ? `+${x[k] - b}ms` : '-');
            return `firstPartial ${f('firstPartialAt')} stable ${f('stablePartialAt')} prefetchDone ${f('prefetchDoneAt')} final ${f('finalAt')} llmReq ${f('llmRequestAt')} firstByte ${f('firstByteAt')} prefetchHit ${x.prefetchHit ?? '-'}`;
          })
          .join('\n')
      : 'no trace yet';
  } catch {
    /* ignore */
  }
}
async function startVoice() {
  const cfg = await (await fetch('/api/config')).json();
  if (!cfg.vapiPublicKey || !cfg.assistantId) {
    $('voice-status').textContent = 'Voice not configured (run npm run live).';
    return;
  }
  $('btn-voice').disabled = true;
  $('voice-status').textContent = 'connectingâ€¦';
  try {
    const { default: Vapi } = await import(VAPI_WEB);
    vapi = new Vapi(cfg.vapiPublicKey);
    vapi.on('message', (m) => {
      if (m.type === 'transcript') {
        const last = caps[caps.length - 1];
        if (last && last.partial && last.role === m.role) caps.pop();
        caps.push({ role: m.role, text: m.transcript, partial: m.transcriptType === 'partial' });
        drawCaptions();
      }
      if (m.type === 'speech-update') refresh();
    });
    vapi.on('error', (e) => {
      $('voice-status').textContent = 'voice error: ' + (e?.message ?? e?.error?.message ?? 'see console');
      console.error(e);
    });
    vapi.on('call-end', () => stopVoice());
    const call = await vapi.start(cfg.assistantId);
    const callId = call?.id;
    if (!callId) throw new Error('no call id returned from start()');
    try { vapi.setMuted(true); } catch { /* ignore */ }
    $('voice-status').textContent = 'bindingâ€¦';
    await api(`/${session.id}/bind`, { method: 'POST', body: JSON.stringify({ callId }) });
    try { vapi.setMuted(false); } catch { /* ignore */ }
    $('voice-status').textContent = 'live â€” talk now';
    $('btn-voice').textContent = 'Stop';
    $('btn-voice').disabled = false;
    pollTimer = setInterval(refresh, 1000);
  } catch (e) {
    $('voice-status').textContent = 'voice failed: ' + e.message;
    stopVoice();
  }
}
function stopVoice() {
  try { vapi?.stop(); } catch { /* ignore */ }
  vapi = null;
  clearInterval(pollTimer);
  $('btn-voice').textContent = 'Start voice';
  $('btn-voice').disabled = false;
}
$('btn-voice').onclick = () => (vapi ? stopVoice() : startVoice());
