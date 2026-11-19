import { describe, it, expect } from 'vitest';
import { AnimationQueue } from '../../public/js/queue.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function make() {
  const played: any[] = [];
  const gates: (() => void)[] = [];
  const q = new AnimationQueue((t: any) => {
    played.push(t);
    return new Promise<void>((r) => gates.push(r));
  });
  return { q, played, gates };
}

describe('AnimationQueue now', () => {
  it('a user-initiated push plays while the assistant speaks; others still wait', async () => {
    const { q, played, gates } = make();
    q.setSpeaking('assistant');
    q.push({ kind: 'fade' });
    q.push({ kind: 'switch', to: 'x' }, { now: true });
    await tick();
    expect(played).toEqual([{ kind: 'switch', to: 'x' }]);
    gates[0]!();
    await tick();
    expect(played).toHaveLength(1); // the fade, queued before, still waits for the gate
    q.setSpeaking(null);
    await tick();
    expect(played).toEqual([{ kind: 'switch', to: 'x' }, { kind: 'fade' }]);
  });
});

describe('AnimationQueue', () => {
  it('plays immediately when nobody is speaking', async () => {
    const { q, played } = make();
    q.push({ kind: 'fork' });
    await tick();
    expect(played).toEqual([{ kind: 'fork' }]);
  });
  it('waits while assistant speaks, plays on null', async () => {
    const { q, played } = make();
    q.setSpeaking('assistant');
    q.push({ kind: 'fork' });
    await tick();
    expect(played).toEqual([]);
    q.setSpeaking(null);
    await tick();
    expect(played).toEqual([{ kind: 'fork' }]);
  });
  it('keeps only the last of each kind while waiting', async () => {
    const { q, played, gates } = make();
    q.setSpeaking('user');
    q.push({ kind: 'fork', to: '1' });
    q.push({ kind: 'fork', to: '2' });
    q.push({ kind: 'fade' });
    q.setSpeaking(null);
    await tick();
    expect(played).toEqual([{ kind: 'fork', to: '2' }]);
    gates[0]();
    await tick();
    expect(played).toEqual([{ kind: 'fork', to: '2' }, { kind: 'fade' }]);
  });
  it('does not start next until previous resolves', async () => {
    const { q, played, gates } = make();
    q.push({ kind: 'fork' });
    q.push({ kind: 'switch' });
    await tick();
    expect(played).toHaveLength(1);
    gates[0]();
    await tick();
    expect(played).toHaveLength(2);
  });
  it('speaking mid-queue: current finishes, rest wait', async () => {
    const { q, played, gates } = make();
    q.push({ kind: 'fork' });
    q.push({ kind: 'fade' });
    await tick();
    q.setSpeaking('assistant');
    gates[0]();
    await tick();
    expect(played).toHaveLength(1);
    q.setSpeaking(null);
    await tick();
    expect(played).toHaveLength(2);
  });
  it('a play rejection does not stall the queue', async () => {
    const played: any[] = [];
    const q = new AnimationQueue((t: any) => {
      played.push(t);
      return played.length === 1 ? Promise.reject(new Error('x')) : Promise.resolve();
    });
    q.push({ kind: 'fork' });
    q.push({ kind: 'fade' });
    await tick();
    await tick();
    expect(played).toHaveLength(2);
  });
});

describe('AnimationQueue informational now-items', () => {
  it('a recap alone plays immediately while the assistant speaks', async () => {
    const { q, played } = make();
    q.setSpeaking('assistant');
    q.push({ kind: 'recap' }, { now: true });
    await tick();
    expect(played).toEqual([{ kind: 'recap' }]);
  });
  it('a recap behind a pending fork waits until the fork plays', async () => {
    const { q, played, gates } = make();
    q.setSpeaking('assistant');
    q.push({ kind: 'fork' });
    q.push({ kind: 'recap' }, { now: true });
    await tick();
    expect(played).toEqual([]);
    q.setSpeaking(null);
    await tick();
    expect(played).toEqual([{ kind: 'fork' }]);
    gates[0]!();
    await tick();
    expect(played).toEqual([{ kind: 'fork' }, { kind: 'recap' }]);
  });
  it('a tap-switch still jumps ahead of a pending fork', async () => {
    const { q, played } = make();
    q.setSpeaking('assistant');
    q.push({ kind: 'fork' });
    q.push({ kind: 'switch', to: 'x' }, { now: true });
    await tick();
    expect(played).toEqual([{ kind: 'switch', to: 'x' }]);
  });
});
