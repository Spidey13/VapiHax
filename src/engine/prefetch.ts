import type { CaseState } from '../case/types.js';
import { setFact } from '../case/facts.js';
import type { Interpreter } from './interpret.js';
import { selectNext, type Selection } from './select.js';

export interface Trace {
  firstPartialAt?: number;
  stablePartialAt?: number;
  prefetchDoneAt?: number;
  finalAt?: number;
  llmRequestAt?: number;
  firstByteAt?: number;
  prefetchHit?: boolean;
}

/** Candidate facts from text, interpreted against a CLONE. Never touches real state. */
async function candidate(state: CaseState, text: string, interpreter: Interpreter): Promise<Record<string, string> | null> {
  const i = await interpreter.interpret(text, structuredClone(state));
  if (i.kind === 'hypothetical' || i.attempt || !i.facts || !Object.keys(i.facts).length) return null;
  return i.facts;
}

const keyOf = (s: CaseState, facts: Record<string, string>) =>
  JSON.stringify([s.sessionId, s.epoch, s.revision, Object.entries(facts).sort(([a], [b]) => a.localeCompare(b))]);

/** Speculative, read-only prefetch driven by stable partial transcripts. Partials never mutate facts. */
export class Prefetcher {
  private lastJson = new Map<string, string>();
  private cache = new Map<string, { key: string; sel: Selection }>(); // newest pending per session
  runs = 0;

  /** Returns true if this partial triggered a prefetch. */
  async onPartial(state: CaseState, text: string, interpreter: Interpreter, trace?: Trace): Promise<boolean> {
    const facts = await candidate(state, text, interpreter);
    const json = facts ? JSON.stringify(Object.entries(facts).sort(([a], [b]) => a.localeCompare(b))) : '';
    const prev = this.lastJson.get(state.sessionId);
    this.lastJson.set(state.sessionId, json);
    if (!facts || json !== prev) return false; // changed (or empty) resets stability
    const key = keyOf(state, facts);
    if (this.cache.get(state.sessionId)?.key === key) return false;
    if (trace) trace.stablePartialAt = Date.now();
    const clone = structuredClone(state);
    for (const [p, v] of Object.entries(facts)) setFact(clone, p, v, 'user-report', { sourceText: text });
    this.runs += 1;
    this.cache.set(state.sessionId, { key, sel: selectNext(clone) });
    if (trace) trace.prefetchDoneAt = Date.now();
    return true;
  }

  /** Look up a prefetch for the final text at the current (pre-apply) revision. */
  async lookup(state: CaseState, text: string, interpreter: Interpreter): Promise<Selection | null> {
    const facts = await candidate(state, text, interpreter);
    if (!facts) return null;
    const hit = this.cache.get(state.sessionId);
    return hit && hit.key === keyOf(state, facts) ? hit.sel : null;
  }

  /** Called after each real final turn so a new utterance starts with fresh stability. */
  endUtterance(sessionId: string): void {
    this.lastJson.delete(sessionId);
    this.cache.delete(sessionId);
  }
}
