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
  render(r.state);
}

function render(s) {
  $('notices').replaceChildren(...s.notices.slice(-4).map((n) => el('div', { className: `notice ${n.kind}`, textContent: `${n.kind}: ${n.text}` })));

  const c = s.currentCheck;
  const box = $('check');
  if (!c) {
    box.className = 'card muted';
    box.textContent = s.pendingQuestion ? 'Waiting on your answer to the question above.' : 'No check right now.';
  } else {
    box.className = 'card';
    const links = c.sources.map((x) => el('a', { href: x.url, target: '_blank', rel: 'noopener', textContent: `${x.id} · ${x.publisher} (${x.mode} ${x.capturedAt})` }));
    const actions = c.terminal
      ? []
      : [
          ['Done – worked', 'it worked', 'ok'],
          ['Done – failed', 'I tried that and it failed', 'bad'],
          ["Haven't done it", "I haven't done that", 'neutral'],
        ].map(([label, text, cls]) => el('button', { className: cls, textContent: label, onclick: () => sendTurn(text) }));
    box.replaceChildren(
      el('p', {}, el('strong', { textContent: 'Do: ' }), c.actionText),
      el('p', {}, el('strong', { textContent: 'Expect: ' }), c.expectedObservation),
      el('p', {}, el('strong', { textContent: 'Stop if: ' }), c.stopConditions),
      el('div', {}, ...links),
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
