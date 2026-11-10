import type { CaseState, Check, DependencyStamp } from '../case/types.js';
import { isStampCurrent } from '../case/store.js';
import type { Selection } from './select.js';

export function isStillCurrent(state: CaseState | undefined, stamp: DependencyStamp | null): boolean {
  return isStampCurrent(state, stamp);
}

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : s;
}

export function checkReply(check: Check, source: 'text' | 'voice'): string {
  const action = source === 'voice' ? firstSentence(check.actionText) : check.actionText;
  return `${action} ${check.expectedObservation}`;
}

export const TEXT = {
  askPlatform: 'Which phone are you pairing with, an iPhone or an Android phone?',
  askGoogleServices: 'Does that Android device have Google Play services? I will not assume it does.',
  handoff:
    'Two checks have now failed, so I will stop here rather than loop. Download the support packet and hand it to Home Assistant or Eve support.',
  unresolved:
    'I have no further supported check for this case right now. Download the support packet to hand off; nothing here is verified as working.',
  recovered: 'Glad to hear it paired. I am recording that as user-reported recovered; I cannot verify it from here.',
  noCurrent: 'I have not given you a check to run yet, so there is nothing to mark.',
  unknown: 'I did not catch a change to your setup.',
  hypothetical: 'That is a what-if, so I have not changed your case.',
  conflictFallback: 'Your typed value and what you said disagree. Should I keep what you typed, or use what you said?',
};

export function selectionReply(state: CaseState, sel: Selection, source: 'text' | 'voice'): string {
  switch (sel.kind) {
    case 'check':
    case 'unsupported':
      return checkReply(sel.check, source);
    case 'clarify':
      if (sel.question === 'phone.platform') return TEXT.askPlatform;
      if (sel.question === 'phone.googleServices') return TEXT.askGoogleServices;
      return [...state.notices].reverse().find((n) => n.kind === 'conflict')?.text ?? TEXT.conflictFallback;
    case 'handoff':
      return TEXT.handoff;
    case 'unresolved':
      return TEXT.unresolved;
  }
}
