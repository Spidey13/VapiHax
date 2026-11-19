const $ = (id) => document.getElementById(id);
let session = null; // { id, token }

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

function showError(msg) { $('error').textContent = msg; }

function renderBranches(s) {
  const byId = Object.fromEntries(s.branches.map((b) => [b.id, b]));
  $('current-name').textContent = byId[s.currentBranchId]?.name ?? '';
  $('branches').replaceChildren(
    ...s.branches.map((b) => {
      const current = b.id === s.currentBranchId;
      const parent = b.parentId ? (byId[b.parentId]?.name ?? b.parentId) : 'none';
      const btn = el('button', { className: `st-${b.status}${current ? ' current' : ''}` },
        b.name,
        el('span', { className: 'meta', textContent: `${b.status} · ${b.origin} · parent: ${parent}${current ? ' · current' : ''}` }));
      if (!current) btn.onclick = () => switchTo(b.id);
      return el('li', {}, btn);
    }),
  );
}

function renderDecision(d) {
  const box = $('decision');
  if (!d) { box.className = 'card muted'; box.textContent = 'No turn yet.'; return; }
  box.className = 'card';
  const rows = [
    ['op', d.op.kind + (d.op.targetId ? ` → ${d.op.targetId}` : '') + (d.op.acknowledge ? ' (ack)' : '')],
    ['intent', d.intent ?? 'none'],
    ['by', d.by],
    ['ms', String(d.ms)],
    ['reason', d.reason],
  ];
  if (d.raw) {
    const r = d.raw;
    rows.push(
      ['intent score', `${r.intent.choice} ${r.intent.confidence}`],
      ['target score', `${r.target.choice} ${r.target.confidence}`],
      ['detail/dir', String(r.detailNotDirection)],
      ['takes up', String(r.takesUpSuggestion)],
    );
  }
  const dl = el('dl', { className: 'dec' });
  for (const [k, v] of rows) dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
  box.replaceChildren(dl);
}

function render(s) {
  const path = $('path');
  const atBottom = path.scrollHeight - path.scrollTop - path.clientHeight < 40;
  path.replaceChildren(
    ...(s.path.length
      ? s.path.map((t) => el('div', { className: `msg ${t.role}${t.scratched ? ' scratched' : ''}`, textContent: t.text }))
      : [el('div', { className: 'muted', textContent: 'Empty branch.' })]),
  );
  if (atBottom) path.scrollTop = path.scrollHeight;
  renderBranches(s);
  renderDecision(s.lastDecision);
}

async function refreshTrace() {
  const t = (await (await api(`/${session.id}/trace`)).json()).traces.slice(-5);
  $('trace').textContent = t.length
    ? t.map((x) => {
        const first = x.firstChunkAt !== undefined && x.llmRequestAt !== undefined ? `${x.firstChunkAt - x.llmRequestAt}ms` : '-';
        return `route ${x.routeMs ?? '-'}ms  op ${x.op ?? '-'}  llm->first chunk ${first}`;
      }).join('\n')
    : 'no trace yet';
}

async function refresh() {
  try {
    render(await (await api(`/${session.id}`)).json());
    await refreshTrace();
  } catch { /* ignore transient poll errors */ }
}

async function sendTurn(text) {
  const r = await (await api(`/${session.id}/turn`, { method: 'POST', body: JSON.stringify({ text }) })).json();
  if ($('chk-tts').checked && 'speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(r.reply));
  render(r.state);
  refreshTrace().catch(() => {});
  return r;
}

async function switchTo(branchId) {
  try {
    showError('');
    render((await (await api(`/${session.id}/switch`, { method: 'POST', body: JSON.stringify({ branchId }) })).json()).state);
  } catch (e) {
    showError(`Switch failed: ${e.message}`);
  }
}

$('btn-start').onclick = async () => {
  const r = await (await fetch('/api/sessions', { method: 'POST' })).json();
  session = { id: r.sessionId, token: r.token };
  $('start').hidden = true;
  $('app').hidden = false;
  render(r.state);
};

$('turn-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('turn-input').value.trim();
  if (!text) return;
  $('turn-input').value = '';
  showError('');
  try {
    await sendTurn(text);
  } catch (err) {
    showError(`Something went wrong: ${err.message}`);
  }
};

// ---- Voice (Vapi web SDK) ----
const VAPI_WEB = 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@3.1.0/+esm';
let vapi = null;
let pollTimer = null;
const caps = []; // {role, text, partial}  display-only

function drawCaptions() {
  $('captions').replaceChildren(
    ...caps.slice(-8).map((c) => el('div', { className: c.partial ? 'partial' : '', textContent: `${c.role === 'user' ? 'You' : 'Assistant'}: ${c.text}` })),
  );
}

async function startVoice() {
  const cfg = await (await fetch('/api/config')).json();
  if (!cfg.vapiPublicKey || !cfg.assistantId) {
    $('voice-status').textContent = 'Voice not configured (missing Vapi public key or assistant id).';
    return;
  }
  $('btn-voice').disabled = true;
  $('voice-status').textContent = 'connecting…';
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
    $('voice-status').textContent = 'binding…';
    await api(`/${session.id}/bind`, { method: 'POST', body: JSON.stringify({ callId }) });
    try { vapi.setMuted(false); } catch { /* ignore */ }
    $('voice-status').textContent = 'live — talk now';
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
