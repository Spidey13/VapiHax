// End screen and share page renderer. All user-derived text is set via textContent / SVG text nodes, never innerHTML.

import { buildMarkdown, endSections } from './endLogic.js';
import { hueFor } from './branchMap.js';
import { createBranchMap } from './branchMapView.js';
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Branch-likes for the map, built from the share payload (nodes in creation order, edges parent -> child). */
export function mapBranches(data) {
  const { nodes, edges = [], mergeEdges = [] } = data.map;
  const names = new Map((data.branches || []).map((b) => [b.id, b.name]));
  const parentOf = new Map(edges.map((e) => [e.to, e.from]));
  const mergedFrom = new Map();
  for (const e of mergeEdges) mergedFrom.set(e.to, [...(mergedFrom.get(e.to) ?? []), e.from]);
  const origins = new Map((data.branches || []).filter((b) => b.origin).map((b) => [b.id, b.origin]));
  const nameOf = (n) => names.get(n.id) || n.label;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // The share payload may not say where a branch came from. A faded copy of a faded parent under the same name
  // is a correction (a correction copies its parent and fades it), so it must not read as a new branch.
  const isCopy = (n) => {
    const p = byId.get(parentOf.get(n.id));
    return !!p && p.status === 'faded' && n.status !== undefined && nameOf(p) === nameOf(n) && !mergedFrom.has(n.id);
  };
  return nodes.map((n) => ({
    id: n.id, parentId: parentOf.get(n.id) ?? null, status: n.status, name: nameOf(n),
    origin: origins.get(n.id) ?? (mergedFrom.has(n.id) ? 'merge' : isCopy(n) ? 'correction' : parentOf.has(n.id) ? 'fork' : 'root'),
    mergedFrom: mergedFrom.get(n.id),
  }));
}

/** The glow behind the end screen keeps the final thread's hue (the share page has its own field). */
function tintField(hue) {
  document.body.style.setProperty('--cur-h', hue);
  const core = document.querySelector('#field .core');
  const wash = document.querySelector('#field .amb');
  if (core) core.style.backgroundColor = `hsl(${hue})`;
  if (wash) wash.style.backgroundColor = `hsl(${hue} / .35)`;
}

/** The whole tree as the same branch map as the session, larger, every row showing its summary line. */
function drawMap(data, currentId) {
  const branches = mapBranches(data);
  const cur = branches.some((b) => b.id === currentId) ? currentId : branches[0].id;
  const box = el('div', 'end-map');
  const nav = el('nav', 'branchmap');
  nav.setAttribute('aria-label', 'Branches');
  box.append(nav);
  const lines = {};
  for (const l of data.summary?.branches ?? []) {
    let text = String(l.line ?? '').replace(/\s+/g, ' ').trim();
    const name = branches.find((b) => b.id === l.id)?.name ?? '';
    // the row already shows the name, so drop a leading "Name: " from the summary line
    if (name && text.toLowerCase().startsWith(`${name.toLowerCase()}:`)) text = text.slice(name.length + 1).trim();
    lines[l.id] = text ? text[0].toUpperCase() + text.slice(1) : text;
  }
  const map = createBranchMap(nav, { large: true, keepMerged: true });
  map.show(branches, cur, { lines });
  map.emphasize('all', { persist: true });
  return { box, hues: new Map(branches.map((b) => [b.id, hueFor(branches, b.id)])), hue: hueFor(branches, cur) };
}

function section(title, ...nodes) {
  const s = el('section', 'end-sec');
  s.append(el('h2', null, title), ...nodes);
  return s;
}
/** items: [{ text, hue? }] */
function bullets(items) {
  const ul = el('ul', 'end-list');
  for (const it of items) {
    const li = el('li', null, it.text);
    if (it.hue) li.style.setProperty('--dot', it.hue);
    ul.append(li);
  }
  return ul;
}

function saveMarkdown(data) {
  const blob = new Blob([buildMarkdown(data)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'brainstorm-summary.md';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  try {
    const ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Render the writing state while /end runs. */
export function renderEnding(container) {
  container.replaceChildren();
  const wrap = el('div', 'end-wait');
  wrap.setAttribute('role', 'status');
  wrap.append(el('p', null, 'Writing your notes…'));
  container.append(wrap);
}

/**
 * opts: { shareUrl, currentId, onRestart, downloadUrl, token }. Download is always built client-side from `data`
 * (one code path for the end screen and the share page), so downloadUrl/token are accepted but unused.
 */
export function renderEndPage(container, data, opts = {}) {
  container.replaceChildren();
  const root = el('article', 'end-page');
  const panel = el('div', 'end-panel');
  panel.append(el('h1', null, 'Your session'));

  let map = null;
  if (data.nothing || !data.summary) {
    panel.append(el('p', 'end-empty', opts.failed ? "Your session has ended, but the notes couldn't load." : 'Nothing to summarise yet.'));
  } else {
    if (data.showMap && data.map?.nodes?.length) {
      map = drawMap(data, opts.currentId);
      tintField(map.hue);
    }
    for (const sec of endSections(data)) {
      if (sec.key === 'glance') panel.append(section(sec.title, el('p', 'end-covered', sec.text)));
      else panel.append(section(sec.title, bullets(sec.items.map((text, i) => ({ text, hue: sec.ids ? map?.hues.get(sec.ids[i]) : undefined })))));
    }
  }
  if (map) root.append(map.box); else root.classList.add('no-map');

  const actions = el('div', 'end-actions');
  const live = el('p', 'end-live');
  live.setAttribute('role', 'status');
  if (!data.nothing && data.summary) {
    const dl = el('button', 'end-btn', 'Download notes');
    dl.type = 'button';
    dl.onclick = () => saveMarkdown(data);
    actions.append(dl);
  }
  const link = opts.shareUrl || (opts.onRestart ? '' : location.href);
  if (link) {
    const cp = el('button', 'end-btn', 'Copy link');
    cp.type = 'button';
    let t;
    cp.onclick = async () => {
      const ok = await copyText(link);
      live.textContent = ok ? 'Copied' : `Copy failed. Link: ${link}`;
      cp.textContent = ok ? 'Copied' : 'Copy link';
      clearTimeout(t);
      t = setTimeout(() => { cp.textContent = 'Copy link'; if (ok) live.textContent = ''; }, 2500);
    };
    actions.append(cp);
  }
  if (opts.onRestart) {
    const again = el('button', 'end-btn primary-btn', 'Start a new session');
    again.type = 'button';
    again.onclick = opts.onRestart;
    actions.append(again);
  }
  panel.append(actions, live);
  root.append(panel);
  container.append(root);
}
