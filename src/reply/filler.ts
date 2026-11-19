/**
 * Each ends in "." and is at least `CHUNK_MIN_CHARACTERS` long, so it is a complete chunk for Vapi's voice chunker (an
 * ellipsis is not a chunk boundary). The SSE writer adds a `<flush />` tag (voiceChunk) so Vapi speaks it at once instead
 * of holding it until the real reply arrives; a trailing space did not do that in the recorded call.
 */
export const FILLERS: readonly string[] = [
  'Right.',
  'Hm, okay.',
  'Mm, let me think.',
  'Okay.',
  'Got it.',
  'Alright.',
  'Okay, let me see.',
];

const NO_REPEAT = 3;

/** The fillers that sound like thinking, for a question; "Got it." or "Okay." before an answer to a question reads as not listening. */
export const THINKING_FILLERS: readonly string[] = ['Hm, okay.', 'Mm, let me think.', 'Okay, let me see.'];

/** Picks a spoken filler at random, never repeating any of the last three (only thinking fillers for a question). */
export class FillerPicker {
  private recent: string[] = [];

  constructor(private random: () => number = Math.random) {}

  pick(question = false): string {
    const from = question ? THINKING_FILLERS : FILLERS;
    let pool = from.filter((f) => !this.recent.includes(f));
    if (!pool.length) pool = from.filter((f) => f !== this.recent.at(-1)); // all recently used: repeat one, but not the last
    const choice = pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))]!;
    this.recent.push(choice);
    if (this.recent.length > NO_REPEAT) this.recent.shift();
    return choice;
  }
}
