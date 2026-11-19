// The branch map: one slim row per branch (a colored dot and a name), joined by hairlines to where it split off.
// DOM only; the ordering lives in branchMap.js. Text goes in via textContent only.
import { mapRows, compactRows } from './branchMap.js';

const LEAVE_MS = 900;
const GROW_MS = 1200;
const TIP_MAX = 90;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clip = (t, n) => { const c = Array.from(t ?? ''); return c.length > n ? `${c.slice(0, n - 1).join('')}…` : c.join(''); };

/**
 * @param {HTMLElement} host a <nav> (or any element) that receives the list
 * @param {{ onSwitch?: ((id: string) => void) | null, large?: boolean, compact?: (() => boolean) | null,
 *   onOpen?: (() => void) | null, measure?: boolean }} [opts]
 *   onSwitch null → a static, non-interactive list (end screen, share page). large → 15px rows.
 *   compact → while it returns true the map shows only the current branch, its parent and "+ N more", and
 *   a transparent button over it calls onOpen (phones: opens the sheet with every branch).
 *   measure → stems are measured from the laid-out rows (rows whose text wraps, as in the sheet).
 */
export function createBranchMap(host, { onSwitch = null, large = false, compact = null, onOpen = null, measure = false, keepMerged = false } = {}) {
  const RH = large ? 30 : 26; // row height
  const XH = large ? 24 : 20; // extra height when a row shows its last line
  host.classList.add('bm', ...(large ? ['bm-large'] : []));
  const list = document.createElement('ol');
  list.className = 'bm-list';
  const tip = document.createElement('div');
  tip.className = 'bm-tip';
  tip.setAttribute('aria-hidden', 'true');
  const more = document.createElement('li');
  more.className = 'bm-more';
  more.style.setProperty('--d', '0');
  let opener = null;
  if (onOpen) {
    opener = document.createElement('button');
    opener.type = 'button';
    opener.className = 'bm-open';
    opener.setAttribute('aria-label', 'Show all branches');
    opener.setAttribute('aria-expanded', 'false');
    opener.addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); onOpen(); });
  }
  host.replaceChildren(...[list, tip, opener].filter(Boolean));

  /** @type {Map<string, { li: HTMLElement, btn: HTMLElement, name: HTMLElement, ln: HTMLElement, leaving?: boolean }>} */
  const items = new Map();
  let rows = [];
  let lines = {};
  let expanded = new Set(); // ids whose last line shows under the name
  let timers = [];
  let emphTimer = null;
  let seeded = false;
  let isCompact = false;
  let last = null; // the last show() arguments, so a change of layout can redraw

  const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };

  function build(r) {
    const li = document.createElement('li');
    li.dataset.id = r.id;
    const btn = document.createElement(onSwitch ? 'button' : 'span');
    btn.className = 'bm-row';
    if (onSwitch) {
      btn.type = 'button';
      btn.addEventListener('click', (e) => {
        if (e.detail > 0) e.currentTarget.blur(); // pointer click: give space-to-hold back to the document
        hideTip();
        onSwitch(r.id);
      });
      btn.addEventListener('pointerenter', () => showTip(r.id));
      btn.addEventListener('pointerleave', hideTip);
      btn.addEventListener('focus', () => showTip(r.id));
      btn.addEventListener('blur', hideTip);
    }
    const dot = document.createElement('i');
    dot.className = 'bm-dot';
    const name = document.createElement('span');
    name.className = 'bm-name';
    const ln = document.createElement('span');
    ln.className = 'bm-ln';
    const head = document.createElement('span');
    head.className = 'bm-head';
    head.append(dot, name);
    btn.append(head, ln);
    li.append(btn);
    return { li, btn, name, ln };
  }

  function showTip(id) {
    const it = items.get(id);
    const text = clip(lines[id] ?? '', TIP_MAX);
    if (!it || !text || expanded.size) { hideTip(); return; }
    tip.textContent = text;
    const h = host.getBoundingClientRect();
    const r = it.btn.getBoundingClientRect();
    const nm = it.name.getBoundingClientRect();
    tip.style.top = `${r.top - h.top + (r.height - 28) / 2}px`;
    tip.style.left = `${nm.right - h.left + 14}px`;
    tip.classList.add('on');
  }
  function hideTip() { tip.classList.remove('on'); }

  /** Stems: each row's hairline reaches up to its parent's dot, however many rows lie between. */
  function layoutStems() {
    const live = rows.map((r) => items.get(r.id));
    const heights = rows.map((r) => RH + (expanded.has(r.id) ? XH : 0));
    const index = new Map(rows.map((r, i) => [r.id, i]));
    rows.forEach((r, i) => {
      const it = live[i];
      const p = r.parentId == null ? -1 : (index.get(r.parentId) ?? -1);
      let span = 0;
      if (p >= 0) {
        if (measure) span = it.li.offsetTop - live[p].li.offsetTop;
        else for (let k = p; k < i; k++) span += heights[k];
      }
      it.li.style.setProperty('--span', `${span}px`);
      it.li.classList.toggle('root', p < 0);
    });
  }

  function paint() {
    rows.forEach((r) => {
      const it = items.get(r.id);
      it.li.style.setProperty('--h', r.hue);
      it.li.style.setProperty('--d', String(r.depth));
      it.li.classList.toggle('cur', r.isCurrent);
      it.li.classList.toggle('aside', r.parked || r.faded);
      it.li.classList.toggle('prov', r.provisional);
      it.li.classList.toggle('merged', r.merged);
      it.li.classList.toggle('exp', expanded.has(r.id));
      if (it.name.textContent !== r.name) it.name.textContent = r.name;
      const ln = clip(lines[r.id] ?? '', TIP_MAX);
      if (it.ln.textContent !== ln) it.ln.textContent = ln;
      it.btn.tabIndex = onSwitch && isCompact ? -1 : 0;
      if (onSwitch) {
        if (r.isCurrent) it.btn.setAttribute('aria-current', 'true'); else it.btn.removeAttribute('aria-current');
        it.btn.setAttribute('aria-label', `${r.name}${r.parked ? ', set aside' : ''}`);
      } else {
        it.li.setAttribute('aria-label', `${r.name}${r.isCurrent ? ', where you ended' : ''}${r.parked ? ', set aside' : ''}`);
      }
    });
    host.classList.toggle('bm-solo', rows.length <= 1);
  }

  /** Re-measure without letting the stems glide (expand/collapse is instant). */
  function snap(fn) {
    list.classList.add('snap');
    fn();
    void list.offsetHeight;
    requestAnimationFrame(() => list.classList.remove('snap'));
  }

  /**
   * @param {Array<any>} branches creation order
   * @param {string} currentId
   * @param {{ animate?: boolean, kind?: string | null, lines?: Record<string,string> }} [o]
   * @returns {Promise<void>} settles when the motion ends
   */
  function show(branches, currentId, { animate = false, kind = null, lines: nextLines } = {}) {
    if (nextLines) lines = { ...lines, ...nextLines };
    last = { branches, currentId, kind };
    let next = mapRows(branches, currentId, { keepMerged });
    isCompact = !!compact?.();
    let hidden = 0;
    if (isCompact) ({ rows: next, more: hidden } = compactRows(next));
    host.classList.toggle('bm-compact', isCompact);
    // In the compact map a switch just redraws: two rows trading places should not slide about.
    const calm = isCompact && (kind === 'switch' || kind === 'park' || kind === 'refresh');
    const motion = animate && seeded && !reduced() && !calm;
    const gone = [...items.keys()].filter((id) => !items.get(id).leaving && !next.some((r) => r.id === id));
    for (const id of gone) {
      const it = items.get(id);
      if (motion) {
        it.leaving = true;
        it.li.classList.add('leaving');
        it.li.classList.toggle('merging', kind === 'merge');
        later(() => { it.li.remove(); items.delete(id); }, LEAVE_MS);
      } else {
        it.li.remove();
        items.delete(id);
      }
    }
    rows = next;
    const created = [];
    for (const r of rows) {
      let it = items.get(r.id);
      if (it?.leaving) { it.li.remove(); items.delete(r.id); it = undefined; } // came back before it finished leaving
      if (!it) { it = build(r); items.set(r.id, it); created.push(r.id); }
    }
    paint();
    // Keep DOM order = row order; rows that are leaving stay where they were until they collapse.
    let ref = list.firstChild;
    for (const r of rows) {
      const li = items.get(r.id).li;
      while (ref && ref !== li && ref.classList?.contains('leaving')) ref = ref.nextSibling;
      if (ref === li) ref = ref.nextSibling; else list.insertBefore(li, ref);
    }
    if (hidden > 0) {
      more.textContent = `+ ${hidden} more`;
      list.append(more); // moves it to the end
    } else more.remove();
    layoutStems();
    list.classList.toggle('scrolls', rows.length > 12);
    if (motion) {
      for (const id of created) {
        const li = items.get(id).li;
        li.classList.add('new');
        later(() => li.classList.remove('new'), GROW_MS);
      }
    }
    // keep the current row in view in a long, scrolling map
    const cur = items.get(currentId);
    if (cur && list.scrollHeight > list.clientHeight + 2) cur.li.scrollIntoView({ block: 'nearest' });
    seeded = true;
    return motion ? new Promise((r) => later(r, kind === 'fork' || kind === 'correction' ? GROW_MS : LEAVE_MS)) : Promise.resolve();
  }

  /**
   * Expand rows to show their last line. ids: 'all' | string[] | null (clear).
   * With `dim`, the other rows fall back to 30%. `persist` keeps it (the end screen).
   * @returns {Promise<void>} settles when the emphasis ends
   */
  function emphasize(ids, { ms = 2500, lines: l, dim = false, persist = false } = {}) {
    clearTimeout(emphTimer);
    if (l) lines = { ...lines, ...l };
    hideTip();
    const apply = (set, dimOthers) => snap(() => {
      expanded = set;
      list.classList.toggle('dimmed', dimOthers);
      host.classList.toggle('emphasis', set.size > 0);
      paint();
      layoutStems();
      list.querySelectorAll('li').forEach((li) => li.classList.toggle('pick', set.has(li.dataset.id)));
    });
    if (!ids) { apply(new Set(), false); return Promise.resolve(); }
    apply(ids === 'all' ? new Set(rows.map((r) => r.id)) : new Set(ids), dim && ids !== 'all');
    if (persist) return Promise.resolve();
    return new Promise((resolve) => {
      emphTimer = setTimeout(() => { apply(new Set(), false); resolve(); }, ms);
    });
  }

  /** Redraw with the last state (the layout changed: phone ⇄ desktop). */
  function redraw() {
    if (last) show(last.branches, last.currentId, { animate: false, kind: null });
  }

  /** Re-measure the stems (the sheet was just revealed). */
  function relayout() { layoutStems(); }

  function setOpen(open) { opener?.setAttribute('aria-expanded', String(open)); }

  function setLines(l) {
    lines = { ...lines, ...l };
    paint();
  }

  function clear() {
    for (const t of timers) clearTimeout(t);
    timers = [];
    clearTimeout(emphTimer);
    items.clear();
    more.remove();
    last = null;
    rows = [];
    expanded = new Set();
    list.replaceChildren();
    hideTip();
    host.classList.remove('emphasis');
    seeded = false;
  }

  return { show, emphasize, setLines, clear, redraw, relayout, setOpen, get rows() { return rows; } };
}
