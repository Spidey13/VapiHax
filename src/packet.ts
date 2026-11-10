import { liveFor } from './sources/exa.js';
import type { CaseState, Check, SourceRef } from './case/types.js';
import { selectNext } from './engine/select.js';
import { selectionReply } from './engine/respond.js';
import { CHECKS, SOURCES } from './rules/checks.js';

export const BANNER = 'EXAMPLE CASE — synthetic household; not a recovered real device';

const IDENTITY_PATHS = [
  'accessory.vendor',
  'accessory.product',
  'accessory.model',
  'accessory.region',
  'accessory.protocol',
  'accessory.firmware',
  'accessory.new',
];
const SETUP_PATHS = [
  'controller.platform',
  'controller.deployment',
  'hub.model',
  'hub.threadRole',
  'topology.otherTbrs',
  'phone.platform',
  'phone.googleServices',
  'phone.os',
  'sync.status',
  'failure.stage',
];

const OUTCOME_LABEL: Record<string, string> = {
  'next-check': 'Next check pending',
  'user-reported-recovered': 'User-reported recovered (not verified)',
  unresolved: 'Unresolved',
  unsupported: 'Unsupported by a documented capability boundary',
  handoff: 'Hand off to support',
};

export interface Packet {
  banner: string;
  outcome: { code: string; label: string };
  identity: { path: string; value: string }[];
  setup: { path: string; value: string; status: string }[];
  attempts: { id: string; checkId: string; outcome: string; applicable: boolean; note?: string }[];
  nextAction: { kind: string; text: string; checkId?: string };
  sources: (SourceRef & { usedBy: string[] })[];
  liveSources: { checkId: string; url: string; title: string; publishedDate: string | null; fetchedAt: string }[];
  notices: string[];
  revision: number;
}

export function buildPacket(state: CaseState): Packet {
  const val = (p: string) => state.facts[p]?.value ?? 'unknown';
  const sel = selectNext(state);
  const checkId = sel.kind === 'check' || sel.kind === 'unsupported' ? sel.check.id : undefined;
  const sourceMap = new Map<string, SourceRef & { usedBy: string[] }>();
  const addChecks: Check[] = CHECKS.filter((c) => state.attempts.some((a) => a.checkId === c.id) || c.id === checkId);
  for (const c of addChecks) {
    for (const s of c.sources) {
      const e = sourceMap.get(s.id) ?? { ...s, usedBy: [] };
      e.usedBy.push(c.id);
      sourceMap.set(s.id, e);
    }
  }
  if (!sourceMap.size) sourceMap.set('R12', { ...SOURCES.R12, usedBy: ['identification'] });
  const text =
    state.outcome === 'user-reported-recovered'
      ? 'No further action. Recovery is reported by the user and not verified.'
      : selectionReply(state, sel, 'text');
  return {
    banner: BANNER,
    outcome: { code: state.outcome, label: OUTCOME_LABEL[state.outcome] ?? state.outcome },
    identity: IDENTITY_PATHS.map((p) => ({ path: p, value: String(val(p)) })),
    setup: SETUP_PATHS.map((p) => ({ path: p, value: String(val(p)), status: state.facts[p]?.status ?? 'unknown' })),
    attempts: state.attempts.map((a) => ({
      id: a.id,
      checkId: a.checkId,
      outcome: a.outcome,
      applicable: a.applicable,
      note: a.note,
    })),
    nextAction: { kind: sel.kind, text, checkId },
    sources: [...sourceMap.values()],
    liveSources: addChecks.flatMap((c) => (liveFor(c.id)?.results ?? []).map((r) => ({ checkId: c.id, url: r.url, title: r.title, publishedDate: r.publishedDate, fetchedAt: r.fetchedAt }))),
    notices: state.notices.map((n) => `${n.kind}: ${n.text}`),
    revision: state.revision,
  };
}

export function toJson(state: CaseState): Packet {
  return buildPacket(state);
}

export function toMarkdown(state: CaseState): string {
  const p = buildPacket(state);
  const L: string[] = [];
  L.push(`**${p.banner}**`, '', '# Support packet', '');
  L.push(`**Outcome:** ${p.outcome.label}`, '');
  L.push('## Accessory identity', '');
  for (const i of p.identity) L.push(`- ${i.path}: ${i.value}`);
  L.push('', '## Reported setup', '');
  for (const s of p.setup) L.push(`- ${s.path}: ${s.value} (${s.status})`);
  L.push('', '## Attempts', '');
  if (!p.attempts.length) L.push('- none recorded');
  for (const a of p.attempts) {
    L.push(`- ${a.checkId}: ${a.outcome}${a.applicable ? '' : ' — no longer applicable'}${a.note ? ` (${a.note})` : ''}`);
  }
  L.push('', p.outcome.code === 'next-check' ? '## Next action' : '## Next action / stop reason', '', p.nextAction.text, '');
  if (p.notices.length) {
    L.push('## Notices', '');
    for (const n of p.notices) L.push(`- ${n}`);
    L.push('');
  }
  L.push('## Sources', '');
  for (const s of p.sources) L.push(`- ${s.title} — ${s.url} (${s.mode} ${s.capturedAt}; used by ${s.usedBy.join(', ')})`);
  if (p.liveSources.length) {
    L.push('', '## Live sources (Exa, supporting only; they did not change any instruction)', '');
    for (const s of p.liveSources) L.push(`- ${s.title} � ${s.url} (live, fetched ${s.fetchedAt}; published ${s.publishedDate ?? 'unknown'}; supports ${s.checkId})`);
  }
  L.push('', '---', 'Generated from user-reported answers. Nothing here is verified against a live device or network.', '');
  return L.join('\n');
}
