import { describe, it, expect } from 'vitest';
import { appendTurn, createSession, forkBranch, renameBranch, scratchLast, setStatus } from '../src/tree/tree.js';
import { effectiveHistory, logicalThreads, topicMemberIds, withoutMetaExchanges } from '../src/tree/history.js';
import { buildContext } from '../src/tree/context.js';
import { correctedMergedPlan, correctedTrip, sameNameTopics, workDecision } from './helpers/voiceScenarios.js';

function correctAgain(s: ReturnType<typeof createSession>, fromId: string, text: string, at: number): string {
  const from = s.branches[fromId]!;
  const b = forkBranch(s, fromId, 'correction', 'live', at);
  renameBranch(s, b.id, from.name);
  setStatus(s, fromId, 'faded', at);
  appendTurn(s, b.id, 'user', text, at + 1, 'correction');
  appendTurn(s, b.id, 'assistant', 'Ok.', at + 2);
  return b.id;
}

describe('logicalThreads', () => {
  it('a correction continues its parent topic: one thread, latest copy is the representative', () => {
    const { session, cityId, snowId, correctedId } = correctedTrip();
    const threads = logicalThreads(session);
    expect(threads.map((x) => x.branch.id)).toEqual([cityId, correctedId]);
    const text = threads[1]!.turns.map((t) => t.text).join('\n');
    expect(text).toContain('a small ryokan');
    expect(text).toContain('Furano, not Niseko');
    expect(text).not.toContain('help me pick a city'); // the parent topic is not repeated
    expect([...topicMemberIds(session)].sort()).toEqual([cityId, snowId, correctedId].sort());
  });

  it('a chain of corrections is still one topic', () => {
    const { session, cityId, correctedId } = correctedTrip();
    const second = correctAgain(session, correctedId, 'actually the second week', 30);
    expect(logicalThreads(session).map((x) => x.branch.id)).toEqual([cityId, second]);
    expect(logicalThreads(session)[1]!.turns.filter((t) => t.kind === 'correction')).toHaveLength(2);
  });

  it('a fully scratched correction resolves to the previous valid representative', () => {
    const { session, cityId, correctedId } = correctedTrip();
    const second = correctAgain(session, correctedId, 'oops never mind', 30);
    for (const t of session.turns.filter((x) => x.branchId === second)) t.scratched = true;
    expect(logicalThreads(session).map((x) => x.branch.id)).toEqual([cityId, correctedId]);
  });

  it('a parent that kept going after the correction stays its own topic', () => {
    const { session, snowId, correctedId } = correctedTrip();
    appendTurn(session, snowId, 'user', 'also leave room for a sauna day', 40);
    const ids = logicalThreads(session).map((x) => x.branch.id);
    expect(ids).toContain(snowId);
    expect(ids).toContain(correctedId);
  });

  it('the latest of several qualifying correction children continues the topic', () => {
    const { session, snowId, correctedId } = correctedTrip();
    const other = correctAgain(session, snowId, 'a different fix', 50);
    const ids = logicalThreads(session).map((x) => x.branch.id);
    expect(ids).toContain(other);
    expect(ids).not.toContain(correctedId);
    expect(ids).not.toContain(snowId);
  });

  it('same-named genuine forks stay separate', () => {
    expect(logicalThreads(sameNameTopics())).toHaveLength(3);
  });

  it('skips branches with no live user turn', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'oops', 1);
    scratchLast(s, 'b1');
    expect(logicalThreads(s)).toEqual([]);
  });

  it('a corrected merge keeps its source topics and carries digests plus a combined note', () => {
    const { session, correctedId } = correctedMergedPlan();
    const threads = logicalThreads(session);
    const merged = threads.find((x) => x.branch.id === correctedId)!;
    expect(merged.notes.some((n) => n.includes('SOURCE-DIGEST-ALPHA'))).toBe(true);
    expect(merged.notes).toContain('Combined from "Mountain week" and "Coast week".');
    expect(threads.map((x) => x.branch.name)).toEqual(expect.arrayContaining(['Mountain week', 'Coast week']));
  });

  it('keeps a work decision with its reason in one thread', () => {
    const t = logicalThreads(workDecision());
    expect(t).toHaveLength(1);
    expect(t[0]!.turns.map((x) => x.text).join('|')).toContain('because new users are dropping off');
  });
});

describe('effectiveHistory', () => {
  it('a corrected branch keeps the whole plan it corrected, and no sibling', () => {
    const { session, cityId, correctedId } = correctedTrip();
    const unrelated = forkBranch(session, cityId, 'fork', 'live', Date.now());
    appendTurn(session, unrelated.id, 'user', 'unrelated sibling sentinel', Date.now());
    const input = effectiveHistory(session, correctedId);
    const text = input.turns.map((t) => t.text).join('\n');
    expect(text).toContain('ski most mornings');
    expect(text).toContain('ryokan');
    expect(text).toContain('Hokkaido');
    expect(text).toContain('Furano, not Niseko');
    expect(text).not.toContain('unrelated sibling sentinel');
  });

  it('drops scratched and blank turns', () => {
    const { session, snowId, correctedId } = correctedTrip();
    session.turns.find((t) => t.text === 'ski most mornings')!.scratched = true;
    appendTurn(session, snowId, 'assistant', '   ', 99);
    const text = effectiveHistory(session, correctedId).turns.map((t) => t.text).join('\n');
    expect(text).not.toContain('ski most mornings');
    expect(text).toContain('a small ryokan');
    expect(effectiveHistory(session, correctedId).turns.every((t) => t.text.trim() !== '')).toBe(true);
  });

  it('notes carry the correction wording', () => {
    const { session, correctedId } = correctedTrip();
    expect(effectiveHistory(session, correctedId).notes).toEqual([
      'The user corrected something earlier: "Furano, not Niseko". Treat the corrected version as current.',
    ]);
  });

  it('a corrected merge keeps the source digests, oldest first, before the correction note', () => {
    const { session, correctedId } = correctedMergedPlan();
    const { notes } = effectiveHistory(session, correctedId);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain('The user corrected something earlier');
    expect(notes[1]).toContain('SOURCE-DIGEST-ALPHA');
    expect(notes[2]).toContain('SOURCE-DIGEST-BETA');
  });

  it('is empty for an unknown branch', () => {
    const { session } = correctedTrip();
    expect(effectiveHistory(session, 'nope')).toEqual({ turns: [], notes: [] });
  });
});

describe('buildContext through a corrected merge', () => {
  it('keeps the merged sources in every reply after the correction', () => {
    const { session, correctedId } = correctedMergedPlan();
    const notes = buildContext(session, correctedId, ['extra']).notes;
    expect(notes.some((n) => n.includes('SOURCE-DIGEST-ALPHA'))).toBe(true);
    expect(notes.some((n) => n.includes('SOURCE-DIGEST-BETA'))).toBe(true);
    expect(notes.at(-1)).toBe('extra');
  });
});

describe('withoutMetaExchanges', () => {
  it('drops a compare or recap reply and the user turn that asked for it, keeping everything else', () => {
    const s = createSession('s', 0);
    const root = s.currentBranchId;
    appendTurn(s, root, 'user', 'A city trip, Tokyo and Kyoto.', 1);
    appendTurn(s, root, 'assistant', 'Nice.', 2);
    appendTurn(s, root, 'user', "What's the difference between the two?", 3);
    appendTurn(s, root, 'assistant', 'Hokkaido is snow and onsen; the city trip is food and temples.', 4, 'compare');
    appendTurn(s, root, 'user', 'Where were we?', 5);
    appendTurn(s, root, 'assistant', 'You have two threads.', 6, 'recap');
    appendTurn(s, root, 'user', 'Add a day in Nara.', 7);
    const kept = withoutMetaExchanges(s.turns).map((t) => t.text);
    expect(kept).toEqual(['A city trip, Tokyo and Kyoto.', 'Nice.', 'Add a day in Nara.']);
  });
});
