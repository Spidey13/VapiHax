/**
 * Plays structural-change animations one at a time, only while nobody is speaking
 * (a transition pushed with `{ now: true }` is user-initiated and plays regardless).
 * A newer transition replaces an unplayed one of the same kind.
 */
/** Recap and compare pushed `now` still wait behind pending structure (fork, merge, ...), which they must not overtake. A tap-switch always jumps. */
const INFORMATIONAL = new Set(['recap', 'compare']);

export class AnimationQueue {
  /** @param {(t: any) => Promise<void> | void} play */
  constructor(play) {
    this.play = play;
    /** @type {any[]} */
    this.pending = [];
    /** @type {'user' | 'assistant' | null} */
    this.who = null;
    this.running = false;
  }

  /** @param {{ kind: string, [k: string]: any }} t
   * @param {{ now?: boolean }} [opts] */
  push(t, { now = false } = {}) {
    this.pending = this.pending.filter((p) => p.kind !== t.kind);
    this.pending.push(now ? { ...t, __now: true } : t);
    this.drain();
  }

  /** @param {'user' | 'assistant' | null} who */
  setSpeaking(who) {
    this.who = who;
    this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const i = this.who === null ? (this.pending.length ? 0 : -1) : this.pending.findIndex((p, j) => p.__now && (!INFORMATIONAL.has(p.kind) || this.pending.slice(0, j).every((q) => q.__now)));
        if (i < 0) break;
        const { __now, ...t } = this.pending.splice(i, 1)[0];
        try {
          await this.play(t);
        } catch {
          // a failed animation must not stall the queue
        }
      }
    } finally {
      this.running = false;
    }
  }
}
