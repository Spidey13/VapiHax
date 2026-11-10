import type { CaseState, DependencyStamp } from '../case/types.js';
import { resolveConflict, setFact } from '../case/facts.js';
import { recordAttempt, supersedeAttempts } from '../case/attempts.js';
import type { Interpreter } from './interpret.js';
import { selectNext, stampFor } from './select.js';
import { selectionReply, TEXT, checkReply } from './respond.js';

export interface TurnResult {
  reply: string;
  stamp: DependencyStamp | null;
  state: CaseState;
}

const PLATFORM_LABEL: Record<string, string> = { ios: 'iPhone', android: 'Android' };

/** Apply the selection to state (currentCheck, outcome, pendingQuestion) and build the reply. */
export function settle(state: CaseState, source: 'text' | 'voice', prefix = ''): TurnResult {
  state.pendingQuestion = null;
  if (state.outcome === 'user-reported-recovered') {
    state.currentCheck = null;
    state.revision += 1;
    return { reply: TEXT.recovered, stamp: stampFor(state, ['phone.platform', 'sync.status']), state };
  }
  const sel = selectNext(state);
  let stamp: DependencyStamp;
  switch (sel.kind) {
    case 'check':
      state.currentCheck = { check: sel.check, stamp: sel.stamp };
      state.outcome = 'next-check';
      stamp = sel.stamp;
      break;
    case 'unsupported':
      state.currentCheck = { check: sel.check, stamp: sel.stamp };
      state.outcome = 'unsupported';
      stamp = sel.stamp;
      break;
    case 'clarify':
      state.currentCheck = null;
      state.outcome = 'next-check';
      if (sel.question !== 'conflict') state.pendingQuestion = sel.question;
      stamp = stampFor(state, sel.paths);
      break;
    case 'handoff':
    case 'unresolved':
      state.currentCheck = null;
      state.outcome = sel.kind;
      stamp = stampFor(state, ['phone.platform', 'sync.status']);
      break;
  }
  state.revision += 1;
  const body = selectionReply(state, sel, source);
  return { reply: prefix ? `${prefix} ${body}` : body, stamp, state };
}

export async function handleTurn(
  state: CaseState,
  text: string,
  source: 'text' | 'voice',
  interpreter: Interpreter,
  now = Date.now(),
): Promise<TurnResult> {
  state.lastActivity = now;

  // Resolve a pending typed-vs-voice conflict from a plain keep/use answer.
  const disputed = Object.values(state.facts).filter((f) => f.status === 'disputed');
  if (disputed.length) {
    const t = text.toLowerCase();
    const choice = /\b(keep|typed|stay|same)\b/.test(t)
      ? 'keep'
      : /\b(use|replace|spoken|said|change|switch)\b/.test(t)
        ? 'replace'
        : null;
    if (choice) {
      for (const f of disputed) resolveConflict(state, f.path, choice, now);
      supersedeAttempts(state, disputed.map((f) => f.path));
      return settle(state, source);
    }
  }

  const interp = await interpreter.interpret(text, state);

  if (interp.kind === 'hypothetical') {
    state.hypothetical = interp.hypotheticalFacts ?? {};
    state.notices.push({ at: now, kind: 'hypothetical', text: 'Treated as a what-if; your case facts were not changed.' });
    state.revision += 1;
    const cur = state.currentCheck;
    const tail = cur ? `Current step: ${checkReply(cur.check, source)}` : selectionReply(state, selectNext(state), source);
    return { reply: `${TEXT.hypothetical} ${tail}`, stamp: cur?.stamp ?? stampFor(state, ['phone.platform']), state };
  }
  state.hypothetical = null;

  const prevCheck = state.currentCheck?.check ?? null;
  const changedPaths: string[] = [];
  const oldValues: Record<string, string | null> = {};
  for (const [path, value] of Object.entries(interp.facts ?? {})) {
    oldValues[path] = state.facts[path]?.value ?? null;
    const r = setFact(state, path, value, 'user-report', { sourceText: text, now });
    if (r.changed || r.disputed) changedPaths.push(path);
  }

  // Sync status belongs to the phone it was run on: a platform change clears it.
  if (changedPaths.includes('phone.platform') && state.facts['sync.status']?.value !== null && !changedPaths.includes('sync.status')) {
    const r = setFact(state, 'sync.status', null, 'user-report', { now });
    if (r.changed) changedPaths.push('sync.status');
  }

  // A plain worked/failed report on a credential-sync check is a sync result.
  if (interp.attempt && prevCheck && /credential-sync$/.test(prevCheck.id) && !interp.facts?.['sync.status']) {
    const o = interp.attempt.outcome;
    const mapped = o === 'succeeded' ? 'reported-done' : o === 'failed' ? 'failed' : null;
    if (mapped && (!interp.attempt.checkId || interp.attempt.checkId === prevCheck.id)) {
      if (setFact(state, 'sync.status', mapped, 'user-report', { sourceText: text, now }).changed) changedPaths.push('sync.status');
    }
  }

  let prefix = '';
  if (changedPaths.length) {
    supersedeAttempts(state, changedPaths);
    const pf = 'phone.platform';
    if (changedPaths.includes(pf) && prevCheck?.dependsOn.includes(pf) && oldValues[pf]) {
      const label = PLATFORM_LABEL[oldValues[pf] as string] ?? 'previous phone';
      const msg = `The ${label} step no longer applies.`;
      state.notices.push({ at: now, kind: 'superseded', text: msg });
      prefix = msg;
    }
  }

  // Mirror a reported sync result onto the sync check that was current.
  const syncNew = interp.facts?.['sync.status'];
  if (syncNew && prevCheck && /credential-sync$/.test(prevCheck.id) && changedPaths.includes('sync.status')) {
    if (syncNew === 'reported-done') recordAttempt(state, prevCheck.id, 'succeeded', now, 'sync reported done');
    if (syncNew === 'failed') recordAttempt(state, prevCheck.id, 'failed', now, 'sync reported failed');
  }

  if (interp.attempt) {
    const checkId = interp.attempt.checkId ?? prevCheck?.id;
    if (!checkId) {
      return { reply: TEXT.noCurrent, stamp: stampFor(state, ['phone.platform']), state };
    }
    recordAttempt(state, checkId, interp.attempt.outcome, now, 'user report');
    if (checkId === 'retry-pairing-once' && interp.attempt.outcome === 'succeeded') {
      state.outcome = 'user-reported-recovered';
    }
  }

  if (!interp.facts && !interp.attempt) {
    const r = settle(state, source);
    return { ...r, reply: `${TEXT.unknown} ${r.reply}` };
  }
  return settle(state, source, prefix);
}
