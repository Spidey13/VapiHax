import { appendTurn, createSession, forkBranch, mergeBranches, renameBranch, setStatus } from '../../src/tree/tree.js';
import type { Session } from '../../src/tree/types.js';

/** Production-shaped correction: a 'correction' fork renamed to its parent, parent faded, correction turn + reply. */
function correct(s: Session, fromId: string, text: string, reply: string, at: number): string {
  const from = s.branches[fromId];
  const b = forkBranch(s, fromId, 'correction', 'live', at);
  renameBranch(s, b.id, from.name);
  setStatus(s, fromId, 'faded', at);
  appendTurn(s, b.id, 'user', text, at + 1, 'correction');
  appendTurn(s, b.id, 'assistant', reply, at + 2);
  return b.id;
}

/** City question, a Hokkaido thread with the user's constraints, then "Furano, not Niseko" as a correction. */
export function correctedTrip(): { session: Session; cityId: string; snowId: string; correctedId: string } {
  const session = createSession('s-trip', 0);
  const cityId = 'b1';
  appendTurn(session, cityId, 'user', 'help me pick a city for a winter trip', 1);
  appendTurn(session, cityId, 'assistant', 'Which kind of trip do you want?', 2);
  const snow = forkBranch(session, cityId, 'fork', 'live', 3);
  renameBranch(session, snow.id, 'Hokkaido ski trip');
  appendTurn(session, snow.id, 'user', 'snow and hot springs', 4);
  appendTurn(session, snow.id, 'assistant', 'Hokkaido fits that well.', 5);
  appendTurn(session, snow.id, 'user', 'Hokkaido', 6);
  appendTurn(session, snow.id, 'assistant', 'Where would you like to sleep?', 7);
  appendTurn(session, snow.id, 'user', 'a small ryokan', 8);
  appendTurn(session, snow.id, 'assistant', 'A ryokan near Niseko works.', 9);
  appendTurn(session, snow.id, 'user', 'ski most mornings', 10);
  appendTurn(session, snow.id, 'assistant', 'Then Niseko has the lifts you need.', 11);
  const correctedId = correct(session, snow.id, 'Furano, not Niseko', 'Furano it is.', 12);
  return { session, cityId, snowId: snow.id, correctedId };
}

/** Two source threads merged (digest sentinels stored on the merge), then the merged thread is corrected. */
export function correctedMergedPlan(): { session: Session; correctedId: string } {
  const session = createSession('s-merged', 0);
  appendTurn(session, 'b1', 'user', 'plan a family week away', 1);
  const a = forkBranch(session, 'b1', 'fork', 'live', 2);
  renameBranch(session, a.id, 'Mountain week');
  appendTurn(session, a.id, 'user', 'hiking above the treeline', 3);
  appendTurn(session, a.id, 'assistant', 'High huts then.', 4);
  session.currentBranchId = 'b1';
  const b = forkBranch(session, 'b1', 'fork', 'live', 5);
  renameBranch(session, b.id, 'Coast week');
  appendTurn(session, b.id, 'user', 'tidepools and a rented kayak', 6);
  appendTurn(session, b.id, 'assistant', 'Calm bays suit kayaks.', 7);
  const merged = mergeBranches(session, a.id, b.id, 8);
  renameBranch(session, merged.id, 'Mountain + coast');
  merged.mergeDigests = [
    'Thread "Mountain week": SOURCE-DIGEST-ALPHA hiking huts above the treeline.',
    'Thread "Coast week": SOURCE-DIGEST-BETA tidepools and kayaking.',
  ];
  appendTurn(session, merged.id, 'user', 'combine them', 9);
  appendTurn(session, merged.id, 'assistant', 'Mountains first, then the coast.', 10);
  const correctedId = correct(session, merged.id, 'make it five days, not seven', 'Five days then.', 11);
  return { session, correctedId };
}

/** A spoken root and two genuine forks that carry the same name. */
export function sameNameTopics(): Session {
  const s = createSession('s-same', 0);
  appendTurn(s, 'b1', 'user', 'what should we cook this weekend', 1);
  appendTurn(s, 'b1', 'assistant', 'A few ideas come to mind.', 2);
  const one = forkBranch(s, 'b1', 'fork', 'live', 3);
  renameBranch(s, one.id, 'Dinner party');
  appendTurn(s, one.id, 'user', 'a dinner party for eight', 4);
  appendTurn(s, one.id, 'assistant', 'Eight is a good size.', 5);
  s.currentBranchId = 'b1';
  const two = forkBranch(s, 'b1', 'fork', 'live', 6);
  renameBranch(s, two.id, 'Dinner party');
  appendTurn(s, two.id, 'user', 'a quiet dinner for two', 7);
  appendTurn(s, two.id, 'assistant', 'Two is intimate.', 8);
  return s;
}

/** A user choice with its reason, a constraint, and an assistant suggestion the user never accepted. */
export function workDecision(): Session {
  const s = createSession('s-work', 0);
  appendTurn(s, 'b1', 'user', 'should we build the sync feature or fix onboarding first', 1);
  appendTurn(s, 'b1', 'assistant', 'You could also rewrite the whole backend.', 2);
  appendTurn(s, 'b1', 'user', 'fix onboarding first, because new users are dropping off', 3);
  appendTurn(s, 'b1', 'assistant', 'Understood.', 4);
  appendTurn(s, 'b1', 'user', 'it has to ship before the end of the month', 5);
  appendTurn(s, 'b1', 'assistant', 'Noted.', 6);
  return s;
}
