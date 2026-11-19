import { describe, expect, it } from 'vitest';
import { appendTurn, scratchLast, createSession, forkBranch, renameBranch, setStatus } from '../src/tree/tree.js';
import { sheetsView } from '../src/view/sheets.js';
import { stateView } from '../src/server.js';

describe('sheetsView', () => {
  it('single branch: no peek, no origin', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'hi', 1);
    const v = sheetsView(s);
    expect(v.peek).toBeNull();
    expect(v.current.originName).toBeNull();
    expect(v.current.path).toHaveLength(1);
    expect(v.parked).toEqual([]);
  });

  it('after a fork the parent peeks and names the origin', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'hi', 1);
    appendTurn(s, 'b1', 'assistant', 'hello there', 2);
    const b = forkBranch(s, 'b1', 'fork', 'provisional', 3);
    const v = sheetsView(s);
    expect(v.current.id).toBe(b.id);
    expect(v.current.originName).toBe('Main');
    expect(v.peek?.id).toBe('b1');
    expect(v.peek?.lastLine).toBe('hello there');
  });

  it('faded parent: no origin and no peek', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'hi', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2);
    setStatus(s, 'b1', 'faded', 3);
    const v = sheetsView(s);
    expect(v.current.originName).toBeNull();
    expect(v.peek).toBeNull();
  });

  it('parked branches are listed, never peeked', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'hi', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2);
    renameBranch(s, 'b1', 'Root');
    setStatus(s, 'b1', 'parked', 3);
    const v = sheetsView(s);
    expect(v.peek).toBeNull();
    expect(v.parked.map((p) => p.id)).toEqual(['b1']);
    expect(v.parked[0].name).toBe('Root');
  });

  it('peek is the most recently active other branch', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'hi', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); // b2
    forkBranch(s, 'b2', 'fork', 'live', 3); // b3 current
    appendTurn(s, 'b1', 'assistant', 'later', 10);
    expect(sheetsView(s).peek?.id).toBe('b1');
  });

  it('lastLine is cut to 90 characters and uses any role', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'x'.repeat(200), 1);
    forkBranch(s, 'b1', 'fork', 'live', 2);
    expect(sheetsView(s).peek?.lastLine).toBe('x'.repeat(90));
  });

  it('lastLine never splits a surrogate pair', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', '\u{1F600}'.repeat(100), 1);
    forkBranch(s, 'b1', 'fork', 'live', 2);
    expect(sheetsView(s).peek?.lastLine).toBe('\u{1F600}'.repeat(90));
  });

  it('a faded non-parent branch is skipped for peek', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'hi', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); // b2
    forkBranch(s, 'b1', 'fork', 'live', 3); // b3 current
    appendTurn(s, 'b2', 'assistant', 'newer but faded', 10);
    setStatus(s, 'b2', 'faded', 11);
    expect(sheetsView(s).peek?.id).toBe('b1');
  });

  it('others lists every live non-current branch, most recent first; peek is the first', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'hi', 1);
    forkBranch(s, 'b1', 'fork', 'live', 2); // b2
    forkBranch(s, 'b1', 'fork', 'live', 3); // b3
    forkBranch(s, 'b1', 'fork', 'live', 4); // b4 current
    appendTurn(s, 'b2', 'assistant', 'newest', 20);
    setStatus(s, 'b3', 'faded', 21);
    forkBranch(s, 'b4', 'fork', 'provisional', 22); // b5 current
    setStatus(s, 'b1', 'parked', 23);
    const v = sheetsView(s);
    expect(v.others.map((o) => o.id)).toEqual(['b2', 'b4']);
    expect(v.peek?.id).toBe('b2');
    expect(v.parked.map((p) => p.id)).toEqual(['b1']);
  });

  it('scratched turns fold out of the rendered path and the peek line, but stay in the data', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'keep', 1);
    appendTurn(s, 'b1', 'assistant', 'kept reply', 2);
    appendTurn(s, 'b1', 'user', 'oops', 3);
    appendTurn(s, 'b1', 'assistant', 'oops reply', 4);
    scratchLast(s, 'b1');
    expect(sheetsView(s).current.path.map((t) => t.text)).toEqual(['keep', 'kept reply']);
    expect(s.turns).toHaveLength(4);
    forkBranch(s, 'b1', 'fork', 'live', 5);
    expect(sheetsView(s).peek?.lastLine).toBe('kept reply');
  });

  it('parked sheets carry a lastLine too', () => {
    const s = createSession('s', 0);
    appendTurn(s, 'b1', 'user', 'hi', 1);
    appendTurn(s, 'b1', 'assistant', 'parked words', 2);
    forkBranch(s, 'b1', 'fork', 'live', 3);
    setStatus(s, 'b1', 'parked', 4);
    expect(sheetsView(s).parked[0].lastLine).toBe('parked words');
  });

  it('is included in stateView', () => {
    const s = createSession('s', 0);
    expect(stateView(s).sheets.current.id).toBe('b1');
  });
});
