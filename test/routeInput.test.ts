import { describe, it, expect } from 'vitest';
import { createSession, appendTurn, forkBranch, setStatus } from '../src/tree/tree.js';
import { buildRouteInput } from '../src/route/input.js';

describe('buildRouteInput', () => {
  it('describes the current branch and up to five non-faded others', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'a weekly newsletter about design', 1);
    appendTurn(s, 'b1', 'assistant', 'what would issue three be?', 2);
    for (let i = 0; i < 6; i++) { forkBranch(s, 'b1', 'fork', 'live', 3 + i); s.currentBranchId = 'b1'; }
    setStatus(s, 'b2', 'faded', 10);
    forkBranch(s, 'b1', 'fork', 'provisional', 11);
    const input = buildRouteInput(s, 'or a podcast?');
    expect(input.utterance).toBe('or a podcast?');
    expect(input.current).toMatchObject({ id: 'b8', provisional: true, lastUser: 'a weekly newsletter about design', lastAssistant: 'what would issue three be?' });
    expect(input.others.map((o) => o.id)).not.toContain('b2');
    expect(input.others.map((o) => o.id)).not.toContain('b8');
    expect(input.others.length).toBeLessThanOrEqual(5);
  });

  it('summarises a branch by its last user turn, cut to 120 characters', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'x'.repeat(300), 1);
    forkBranch(s, 'b1', 'fork', 'live', 2);
    expect(buildRouteInput(s, 'hi').others[0].summary).toHaveLength(120);
  });

  it('skips scratched turns for lastUser, lastAssistant and summaries', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'keep me', 1);
    appendTurn(s, 'b1', 'assistant', 'kept reply', 2);
    appendTurn(s, 'b1', 'user', 'scratch me', 3).scratched = true;
    appendTurn(s, 'b1', 'assistant', 'scratched reply', 4).scratched = true;
    forkBranch(s, 'b1', 'fork', 'live', 5);
    const input = buildRouteInput(s, 'x');
    expect(input.current).toMatchObject({ lastUser: 'keep me', lastAssistant: 'kept reply' });
    s.currentBranchId = 'b2';
    appendTurn(s, 'b2', 'user', 'gone', 6).scratched = true;
    s.currentBranchId = 'b1';
    expect(buildRouteInput(s, 'x').others.find((o) => o.id === 'b2')?.summary).toBe('keep me');
  });
});
