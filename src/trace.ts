import type { RawAnswers } from './route/types.js';

export interface TurnTrace {
  firstPartialAt?: number;
  finalAt?: number;
  llmRequestAt?: number;
  /** When a partial transcript first repeated, so speculation could start. */
  stablePartialAt?: number;
  /** True when the final transcript reused the speculated routing decision. */
  speculationHit?: boolean;
  routeMs?: number;
  routeBy?: 'jev' | 'fallback';
  op?: string;
  /** The router's reason (policy rule, or the fallback cause such as `timeout`). Diagnostics. */
  routeReason?: string;
  /** Jev's raw answers when it answered in time. Diagnostics. */
  routeRaw?: RawAnswers;
  /** What the turn actually did to the tree, which can differ from `op` (a "yes" accepting a merge offer on `continue`). */
  appliedOp?: string;
  /** Characters in the reply context: all messages, and the system notes (corrections, merge digests, compare digest, instruction). */
  contextChars?: number;
  notesChars?: number;
  /** Reply stream diagnostics (Date.now): `message_start`, first thinking block, first text delta. */
  modelFirstEventAt?: number;
  modelThinkingStartAt?: number;
  modelFirstTextAt?: number;
  modelThinkingTokens?: number;
  modelInputTokens?: number;
  modelCacheReadTokens?: number;
  modelCacheWriteTokens?: number;
  /** When the server wrote the first reply text to the SSE stream (emission, not audio). */
  firstChunkAt?: number;
  /**
   * Server receipt of the first `assistant.speechStarted` of the next assistant turn after this trace's first
   * emission: provider playback evidence, not server emission.
   */
  playbackStartedAt?: number;
  /** When the first filler or sentence of this request was written (wall clock, like webhook receipt times). */
  firstEmitAt?: number;
  /** The model's stop reason for this reply (`end_turn`, `max_tokens`, `refusal`, `unknown`, ...). */
  modelStopReason?: string;
  /** The refusal category from the model's `stop_details` when it declined (`cyber`, `bio`, ...), else null/undefined. */
  modelStopCategory?: string | null;
  /** When the reply model was called (after routing and any digest wait). */
  modelRequestAt?: number;
  /** The reply's output tokens as the stream reported them (thinking included). */
  modelOutputTokens?: number;
  /** Set when a filler was emitted because the first sentence took over 250 ms. */
  filler?: boolean;
  /** When the filler was emitted. */
  fillerAt?: number;
  /** When the first real (non-filler) sentence was emitted by the server. */
  firstSentenceAt?: number;
  doneAt?: number;
}

const MAX_TRACES = 50;

export class TraceStore {
  private bySession = new Map<string, TurnTrace[]>();

  /** The in-progress trace for this utterance, creating one if the last already got its first reply chunk. */
  current(sessionId: string, from: 'partial' | 'llm' | 'final'): TurnTrace {
    const list = this.bySession.get(sessionId) ?? [];
    this.bySession.set(sessionId, list);
    let cur = list[list.length - 1];
    const done = cur?.firstChunkAt !== undefined;
    const startsNew = !cur || done || (from === 'partial' && cur.llmRequestAt !== undefined);
    if (startsNew) {
      cur = {};
      list.push(cur);
      if (list.length > MAX_TRACES) list.shift();
    }
    return cur!;
  }

  list(sessionId: string): TurnTrace[] {
    return this.bySession.get(sessionId) ?? [];
  }
}
