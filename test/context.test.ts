import { describe, it, expect } from 'vitest';
import { createSession, appendTurn, forkBranch, mergeBranches } from '../src/tree/tree.js';
import { buildContext } from '../src/tree/context.js';

describe('buildContext', () => {
  it('excludes sibling branches and scratched turns', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'newsletter', 1);
    appendTurn(s, 'b1', 'assistant', 'weekly?', 2);
    forkBranch(s, 'b1', 'fork', 'live', 3);
    appendTurn(s, 'b2', 'user', 'podcast instead', 4);
    s.currentBranchId = 'b1';
    appendTurn(s, 'b1', 'user', 'monthly maybe', 5).scratched = true;
    appendTurn(s, 'b1', 'user', 'every two weeks', 6);
    expect(buildContext(s, 'b1').messages).toEqual([
      { role: 'user', content: 'newsletter' },
      { role: 'assistant', content: 'weekly?' },
      { role: 'user', content: 'every two weeks' },
    ]);
    expect(buildContext(s, 'b2').messages.map((m) => m.content)).toEqual(['newsletter', 'weekly?', 'podcast instead']);
  });

  it('adds one note per correction on the path, naming the corrected words', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'trip for three people', 1);
    forkBranch(s, 'b1', 'correction', 'live', 2);
    appendTurn(s, 'b2', 'user', 'no wait, four people', 3, 'correction');
    const ctx = buildContext(s, 'b2');
    expect(ctx.notes).toEqual(['The user corrected something earlier: "no wait, four people". Treat the corrected version as current.']);
  });

  it('skips turns with empty text', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'hi', 1);
    appendTurn(s, 'b1', 'assistant', '  ', 2);
    appendTurn(s, 'b1', 'user', 'again', 3);
    expect(buildContext(s, 'b1').messages.map((m) => m.content)).toEqual(['hi', 'again']);
  });

  it('has no notes when there are no corrections', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'hi', 1);
    expect(buildContext(s, 'b1').notes).toEqual([]);
  });

  it('appends per-turn extra notes (compare) and a merged branch keeps its digests', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'x', 1);
    expect(buildContext(s, 'b1', ['digest']).notes).toEqual(['digest']);
    forkBranch(s, 'b1', 'fork', 'live', 2);
    forkBranch(s, 'b1', 'fork', 'live', 3);
    const m = mergeBranches(s, 'b2', 'b3', 4);
    expect(buildContext(s, m.id).notes).toEqual([]);
    m.mergeDigests = ['kept'];
    expect(buildContext(s, m.id).notes).toEqual(['kept']);
  });
});
