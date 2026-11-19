import type { Intent, Op, RawAnswers, RouteInput } from './types.js';

export const THRESHOLDS = { intent: 0.6, detailHigh: 0.6, detailLow: 0.3, target: 0.5, takesUp: 0.7, ackHigh: 0.85 } as const;

/** Intent confidence at which a compare is accepted when another thread exists (merge and the rest stay at THRESHOLDS.intent). */
const COMPARE_MIN = 0.5;

export type Thresholds = { [K in keyof typeof THRESHOLDS]: number };

/** Spec 3.3: the acknowledge band starts at the accept threshold and ends at ackHigh. */
const inAckBand = (confidence: number, t: Thresholds): boolean => confidence >= t.intent && confidence < t.ackHigh;

type Decision = { op: Op; intent: Intent | null; reason: string };

/**
 * Wording that offers an alternative ("another option is", "you could also", "instead", "what about").
 * Jev's takes-up answer can be high when the user simply answers a plain question with their own refinement
 * ("How about we do this on a Saturday afternoon?"), so the takes-up rule needs an offer to take up.
 */
const OFFERS_ALTERNATIVE =
  /\b(another|alternative(?:ly)?|instead|rather than|(?:could|might|can) also|or (?:you|we) could|what about|how about|what if|one option|other option|you might consider)\b/i;

/** True when the assistant's last line offered an alternative the user could take up. */
export function offersAlternative(lastAssistant: string | null): boolean {
  return !!lastAssistant && OFFERS_ALTERNATIVE.test(lastAssistant);
}

export function decide(raw: RawAnswers, input: RouteInput, thresholds: Thresholds = THRESHOLDS): Decision {
  const d = decideOp(raw, input, thresholds);
  // Structural guard: with no user turn on the current path there is nothing to branch from or correct.
  if (input.current.lastUser === null && (d.op.kind === 'fork' || d.op.kind === 'correct')) {
    return { op: { kind: 'continue' }, intent: d.intent, reason: 'nothing to branch from yet' };
  }
  return d;
}

function decideOp(raw: RawAnswers, input: RouteInput, t: Thresholds): Decision {
  const { choice, confidence } = raw.intent;

  if (raw.takesUpSuggestion >= t.takesUp && (choice === 'continue' || choice === 'newDirection') && offersAlternative(input.current.lastAssistant)) {
    return { op: { kind: 'fork', acknowledge: inAckBand(raw.takesUpSuggestion, t) }, intent: choice, reason: `takes up suggestion (${raw.takesUpSuggestion})` };
  }

  // A false compare only speaks a comparison (no tree change), so it is accepted a little lower than the ops that change the tree.
  if (confidence < (choice === 'compare' && input.others.length > 0 ? Math.min(t.intent, COMPARE_MIN) : t.intent)) {
    return { op: { kind: 'continue' }, intent: null, reason: `low intent confidence (${confidence})` };
  }

  switch (choice) {
    case 'newDirection':
    case 'correction':
      if (raw.detailNotDirection >= t.detailHigh) {
        return { op: { kind: 'correct' }, intent: choice, reason: `detail change (${raw.detailNotDirection})` };
      }
      return { op: { kind: 'fork', acknowledge: inAckBand(confidence, t) }, intent: choice, reason: `new direction (${confidence}, detail ${raw.detailNotDirection})` };
    case 'switchBack': {
      const known = input.others.some((o) => o.id === raw.target.choice);
      if (raw.target.confidence >= t.target && known) {
        return { op: { kind: 'switch', targetId: raw.target.choice }, intent: choice, reason: `switch to ${raw.target.choice} (${raw.target.confidence})` };
      }
      return { op: { kind: 'ask-which' }, intent: choice, reason: `unclear switch target (${raw.target.choice}, ${raw.target.confidence})` };
    }
    case 'park': {
      const targeted = raw.target.confidence >= t.target && input.others.some((o) => o.id === raw.target.choice);
      return { op: targeted ? { kind: 'park', targetId: raw.target.choice } : { kind: 'park' }, intent: choice, reason: 'park command' };
    }
    case 'scratch':
    case 'recap':
      return { op: { kind: choice }, intent: choice, reason: `${choice} command` };
    case 'compare':
    case 'merge': {
      if (input.others.length === 0) return { op: { kind: 'only-one-thread' }, intent: choice, reason: `${choice} with no other thread` };
      const confident = raw.target.confidence >= t.target && input.others.some((o) => o.id === raw.target.choice);
      // `others` is ordered most recently active first.
      const otherId = confident ? raw.target.choice : input.others[0].id;
      if (choice === 'compare') return { op: { kind: 'compare', otherId }, intent: choice, reason: `compare with ${otherId}` };
      if (confident || input.others.length === 1) return { op: { kind: 'merge', otherId }, intent: choice, reason: `merge with ${otherId}` };
      return { op: { kind: 'ask-merge' }, intent: choice, reason: 'merge target unclear among several threads' };
    }
    default:
      return { op: { kind: 'continue' }, intent: choice, reason: `${choice} continues for now` };
  }
}
