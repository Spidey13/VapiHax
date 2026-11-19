// Pure logic for the end screen: no DOM. Shared by the end screen and the share page.
const NOTHING = 'Nothing to summarise yet.';
const oneLine = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
/** One line, with Markdown syntax neutralised. Kept in step with esc in src/view/summaryMarkdown.ts. */
const escapeMd = (t) =>
  oneLine(t)
    .replace(/[\\*_<[\]`]/g, '\\$&')
    .replace(/^([#>+=-])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2');

const MAX_W = 132; // fits a 140px column
const FONT = 11;
const CHAR_W = 6.6; // generous average advance at 11px, so 18 characters stay inside the rect

export function mapLabel(label) {
  const len = Array.from(String(label)).length;
  return { w: Math.min(MAX_W, Math.max(44, Math.ceil(len * CHAR_W + 20))), h: 28, font: FONT };
}

function direction(data, l) {
  const name = (data.branches || []).find((b) => b.id === l.id)?.name ?? '';
  const text = oneLine(l.line);
  return !name || text.startsWith(name) ? text : `${oneLine(name)}: ${text}`;
}

/**
 * The sections the end page and the share page show, in order: At a glance always, then Topics, Worth keeping in mind
 * and Still open only when they have content. Topics carry the branch ids so the page can colour each row.
 */
export function endSections(data) {
  const sum = data?.summary;
  if (!sum) return [];
  const out = [{ key: 'glance', title: 'At a glance', text: String(sum.covered ?? '') }];
  const topics = (sum.branches ?? []).map((l) => ({ id: l.id, text: direction(data, l) }));
  if (topics.length) out.push({ key: 'topics', title: 'Topics', items: topics.map((x) => x.text), ids: topics.map((x) => x.id) });
  const considerations = sum.considerations ?? [];
  if (considerations.length) out.push({ key: 'considerations', title: 'Worth keeping in mind', items: considerations.slice() });
  const open = sum.open ?? [];
  if (open.length) out.push({ key: 'open', title: 'Still open', items: open.slice() });
  return out;
}

/** Plain-text/markdown summary, kept in step with the server's summaryMarkdown. */
export function buildMarkdown(data) {
  const sum = data?.summary;
  if (data?.nothing || !sum) return `# Brainstorm summary\n\n${NOTHING}\n`;
  const rows = (title, items) => (items.length ? [`## ${title}`, '', ...items, ''] : []);
  const topics = sum.branches.map((l) => {
    const name = (data.branches || []).find((b) => b.id === l.id)?.name ?? '';
    const text = oneLine(l.line);
    return !name || text.startsWith(name) ? `- ${escapeMd(text)}` : `- **${escapeMd(name)}**: ${escapeMd(text)}`;
  });
  return [
    '# Brainstorm summary', '', '## At a glance', '', escapeMd(sum.covered), '',
    ...rows('Topics', topics),
    ...rows('Worth keeping in mind', (sum.considerations ?? []).map((c) => `- ${escapeMd(c)}`)),
    ...rows('Still open', sum.open.map((o) => `- ${escapeMd(o)}`)),
  ].join('\n');
}

export const directionLines = (data) => (data.summary?.branches ?? []).map((l) => direction(data, l));

/** Map data -> drawable model. opts.currentId emphasises one thread; default is the main (first) thread. */
export function mapModel(data, opts = {}) {
  const map = data?.map;
  if (!map || !map.nodes?.length) return { width: 0, height: 0, nodes: [], links: [], aria: '' };
  const sources = new Set((map.mergeEdges ?? []).map((e) => e.from));
  const currentId = map.nodes.some((n) => n.id === opts.currentId) ? opts.currentId : map.nodes[0].id;
  const pad = 8;
  const nodes = map.nodes.map((n) => {
    const { w, h, font } = mapLabel(n.label);
    return { id: n.id, label: n.label, x: n.x + pad, y: n.y, w, h, font, current: n.id === currentId, dim: n.status === 'faded' || sources.has(n.id) };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const link = (e, dashed) => {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) return null;
    const y1 = a.y + a.h / 2, y2 = b.y - b.h / 2, my = (y1 + y2) / 2;
    return { dashed, from: e.from, to: e.to, d: `M${a.x} ${y1} C${a.x} ${my} ${b.x} ${my} ${b.x} ${y2}` };
  };
  const links = [...(map.edges ?? []).map((e) => link(e, false)), ...(map.mergeEdges ?? []).map((e) => link(e, true))].filter(Boolean);
  const names = nodes.map((n) => n.label).join(', ');
  return {
    width: map.width + pad * 2,
    height: map.height,
    nodes,
    links,
    aria: `Map of ${nodes.length} threads: ${names}. Dashed lines show threads that were merged.`,
  };
}
