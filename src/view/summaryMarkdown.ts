import type { Session } from '../tree/types.js';

const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();
/** One line, with Markdown syntax neutralised. Kept in step with escapeMd in public/js/endLogic.js. */
const esc = (t: string) =>
  oneLine(t)
    .replace(/[\\*_<[\]`]/g, '\\$&')
    .replace(/^([#>+=-])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2');

export const NOTHING_TO_SUMMARISE = 'Nothing to summarise yet.';

/** At a glance, Topics, then Worth keeping in mind and Still open when they have content. Mirrors buildMarkdown in public/js/endLogic.js. */
export function summaryMarkdown(s: Session): string {
  const sum = s.ended?.summary ?? null;
  if (!sum) return `# Brainstorm summary\n\n${NOTHING_TO_SUMMARISE}\n`;
  const topics = sum.branches.map((l) => {
    const name = Object.hasOwn(s.branches, l.id) ? s.branches[l.id]!.name : '';
    const text = oneLine(l.line);
    return !name || text.startsWith(name) ? `- ${esc(text)}` : `- **${esc(name)}**: ${esc(text)}`;
  });
  const considerations = (sum.considerations ?? []).map((c) => `- ${esc(c)}`);
  const open = sum.open.map((o) => `- ${esc(o)}`);
  const section = (title: string, rows: string[]) => (rows.length ? [`## ${title}`, '', ...rows, ''] : []);
  return [
    '# Brainstorm summary',
    '',
    '## At a glance',
    '',
    esc(sum.covered),
    '',
    ...section('Topics', topics),
    ...section('Worth keeping in mind', considerations),
    ...section('Still open', open),
  ].join('\n');
}
