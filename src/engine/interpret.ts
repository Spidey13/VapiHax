import type { AttemptOutcome, CaseState } from '../case/types.js';

export type InterpretationKind = 'assertion' | 'correction' | 'hypothetical' | 'attempt-report' | 'unknown';

export interface Interpretation {
  kind: InterpretationKind;
  /** Facts the speaker asserts about their actual setup (never populated for hypotheticals). */
  facts?: Record<string, string>;
  /** Facts that were only asked about hypothetically. Never merged into case facts. */
  hypotheticalFacts?: Record<string, string>;
  /** A report about a check result. checkId undefined = the current check. */
  attempt?: { checkId?: string; outcome: AttemptOutcome };
  confidence: 'rule';
}

export interface Interpreter {
  interpret(text: string, state: CaseState): Promise<Interpretation>;
}

const PLATFORM_RE = /\b(iphone|ipad|ios|android|pixel|galaxy)\b/g;

/** Last non-negated platform mention in the text, or null. */
function detectPlatform(t: string): 'ios' | 'android' | null {
  let found: 'ios' | 'android' | null = null;
  for (const m of t.matchAll(PLATFORM_RE)) {
    const before = t.slice(Math.max(0, (m.index ?? 0) - 24), m.index);
    if (/\b(not|instead of|rather than|isn'?t|no longer)\s+(the |my |an? )?(\w+\s+)?$/.test(before)) continue;
    found = /iphone|ipad|ios/.test(m[1]) ? 'ios' : 'android';
  }
  return found;
}

const CORRECTION_MARKER = /\b(actually|correction|sorry|wait|i meant|instead|back to|switch(?:ed|ing)? (?:to|back)|changed my mind|no,)\b/;
const HYPOTHETICAL = /^(would|could|should|what if|what about|if i|do you think|might)\b|\b(would|could|might)\b[^.?!]*\b(help|work|fix|make a difference)\b/;

function detectGoogleServices(t: string, state: CaseState): 'yes' | 'no' | null {
  if (/(google (play )?services|play services|\bgms\b|google play)/.test(t)) {
    if (/\b(no|not|without|doesn'?t|don'?t|isn'?t|lacks?|missing)\b/.test(t)) return 'no';
    return 'yes';
  }
  if (state.pendingQuestion === 'phone.googleServices') {
    if (/^(yes|yeah|yep|yup|sure|it does|i do|correct)\b/.test(t)) return 'yes';
    if (/^(no|nope|nah|it doesn'?t|i don'?t)\b/.test(t)) return 'no';
  }
  return null;
}

function detectSync(t: string): string | null {
  if (!/\bsync/.test(t)) return null;
  if (/\b(haven'?t|have not|never|not yet|didn'?t)\b[^.]*\bsync/.test(t)) return 'not-done';
  if (/\b(fail|failed|failure|error|didn'?t work|did not work|unsuccessful)\b/.test(t)) return 'failed';
  if (/\b(success|successful|succeeded|worked|done|complete|completed|finished|went through)\b/.test(t)) return 'reported-done';
  return null;
}

function detectHub(t: string): string | null {
  if (/apple\s*tv/.test(t) && /4k/.test(t) && /(3rd|third|3 gen|gen(eration)? 3)/.test(t) && /64\s*(gb|gig)/.test(t) && /wi-?fi/.test(t)) {
    return 'apple-tv-4k-3gen-64gb-wifi';
  }
  return null;
}

function detectAttempt(t: string): { checkId?: string; outcome: AttemptOutcome } | null {
  // "never paired", "didn't pair" etc. are failures, not successes.
  const negatedPaired = /\b(never|not|n't|no)\s+(\w+\s+){0,2}paired\b/.test(t);
  if (
    /\b(failed|fails|didn'?t work|did not work|doesn'?t work|no luck|same error|still (?:fail|failed|fails|doesn'?t|won'?t|not)|unsuccessful)\b/.test(t) ||
    negatedPaired
  ) {
    return { outcome: 'failed' };
  }
  if (/\b(haven'?t|have not|not yet|didn'?t (do|try)|not done|haven'?t (done|tried))\b/.test(t)) {
    return { outcome: 'not-started' };
  }
  if (/\b(paired|pairing worked|plug turns on|turns on|added to home assistant|commissioned)\b/.test(t)) {
    return { checkId: 'retry-pairing-once', outcome: 'succeeded' };
  }
  if (/\b(it worked|that worked|worked|succeeded|success)\b/.test(t)) {
    return { outcome: 'succeeded' };
  }
  if (/\b(skip(ped)?|i('ll| will)? skip)\b/.test(t)) return { outcome: 'skipped' };
  return null;
}

export class RuleInterpreter implements Interpreter {
  async interpret(text: string, state: CaseState): Promise<Interpretation> {
    return interpretRules(text, state);
  }
}

export function interpretRules(text: string, state: CaseState): Interpretation {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const out: Interpretation = { kind: 'unknown', confidence: 'rule' };
  const platform = detectPlatform(t);

  // Hypotheticals never produce facts.
  if (HYPOTHETICAL.test(t) && (platform || /\?\s*$/.test(t))) {
    out.kind = 'hypothetical';
    if (platform) out.hypotheticalFacts = { 'phone.platform': platform };
    return out;
  }

  const facts: Record<string, string> = {};
  if (platform) facts['phone.platform'] = platform;
  const gs = detectGoogleServices(t, state);
  if (gs) facts['phone.googleServices'] = gs;
  const sync = detectSync(t);
  if (sync) facts['sync.status'] = sync;
  const hub = detectHub(t);
  if (hub) facts['hub.model'] = hub;
  // Identifiers come only from exact matches, never from "Eve plug"-style phrases.
  const product = text.match(/\b10EBU4151\b/i);
  if (product) facts['accessory.product'] = '10EBU4151';
  const model = text.match(/\b20EBU4101\b/i);
  if (model) facts['accessory.model'] = '20EBU4101';

  // Sync outcomes are recorded as facts (and mirrored onto the current check by the turn handler), not as a free attempt.
  const attempt = sync ? null : detectAttempt(t);

  if (Object.keys(facts).length) out.facts = facts;
  if (attempt) out.attempt = attempt;

  const platformFact = state.facts['phone.platform'];
  const differsFromCurrent =
    !!platform && platformFact?.status === 'confirmed' && platformFact.value !== null && platformFact.value !== platform;
  if (platform && (CORRECTION_MARKER.test(t) || differsFromCurrent)) out.kind = 'correction';
  else if (attempt && !platform) out.kind = 'attempt-report';
  else if (out.facts) out.kind = 'assertion';
  else if (attempt) out.kind = 'attempt-report';
  return out;
}
