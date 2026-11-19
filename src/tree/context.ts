import { effectiveHistory } from './history.js';
import type { Session } from './types.js';

export interface BranchContext {
  messages: { role: 'user' | 'assistant'; content: string }[];
  notes: string[];
}

/** `extraNotes` are per-turn notes (a compare's digest); merge digests and corrections come from the effective history. */
export function buildContext(s: Session, branchId: string, extraNotes?: string[]): BranchContext {
  const { turns, notes } = effectiveHistory(s, branchId);
  return {
    messages: turns.map((t) => ({ role: t.role, content: t.text })),
    notes: notes.concat(extraNotes ?? []),
  };
}
