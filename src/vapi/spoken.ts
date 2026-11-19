import { cutAfterWords, tokenize } from './reconcile.js';

const KEEP = 20;
/** An assistant transcript this long after its segment's "stopped" shows the segment is still being spoken. */
const REOPEN_AFTER_MS = 1000;

interface Segment { at: number; stoppedAt?: number; finals: string[]; partial: string }

/**
 * What the Vapi events webhook has shown per session: when the caller started speaking and when model text (not a
 * filler) started playing. Evidence only: with no events everything answers "unknown" and callers fall back to the
 * request bodies alone. Timestamps are server receipt times (Date.now()).
 */
export class SpokenLog {
  private readonly users = new Map<string, number[]>();
  private readonly playbacks = new Map<string, number[]>();
  /** Assistant speech-update "started" events: the Vapi turn number (when sent) and the time. */
  private readonly starts = new Map<string, { turn?: number; at: number }[]>();
  /** Vapi turns whose speechStarted text was only fillers, and turns that showed real model text. */
  private readonly fillerTurns = new Map<string, Set<number>>();
  private readonly realTurns = new Map<string, Set<number>>();
  /** One entry per assistant speech-update "started": what its transcripts said, and whether it has stopped. */
  private readonly segments = new Map<string, Segment[]>();
  private readonly interrupts = new Map<string, number[]>();
  /** Interruptions as playback evidence: when, and the Vapi turn of the latest assistant start (judged lazily, like `starts`). */
  private readonly cutPlaybacks = new Map<string, { at: number; turn?: number }[]>();
  /** When the caller's speech-to-text FINAL transcripts arrived (partials are not kept). */
  private readonly userFinals = new Map<string, number[]>();
  private readonly userPartials = new Map<string, { at: number; text: string }[]>();

  private static push<T>(m: Map<string, T[]>, id: string, v: T): void {
    const list = m.get(id) ?? [];
    list.push(v);
    if (list.length > KEEP) list.shift();
    m.set(id, list);
  }

  private static mark(m: Map<string, Set<number>>, id: string, turn: number): void {
    const set = m.get(id) ?? new Set<number>();
    set.add(turn);
    if (set.size > KEEP) set.delete(set.values().next().value as number);
    m.set(id, set);
  }

  userStarted(id: string, at: number): void {
    SpokenLog.push(this.users, id, at);
  }

  /** A caller transcript arrived at `at`: finals and partials are kept apart (a partial with its text). */
  userTranscript(id: string, final: boolean, at: number, text = ''): void {
    if (final) SpokenLog.push(this.userFinals, id, at);
    else SpokenLog.push(this.userPartials, id, { at, text });
  }

  /** The latest caller partial transcript received at or after `t`, or undefined. */
  userPartialAfter(id: string, t: number): { at: number; text: string } | undefined {
    const list = this.userPartials.get(id) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.at >= t) return list[i];
    return undefined;
  }

  /** The first caller final transcript received at or after `t`, or undefined. */
  userFinalAfter(id: string, t: number): number | undefined {
    return this.userFinals.get(id)?.find((at) => at >= t);
  }

  /** Model text (or an interruption of the assistant) was heard at `at`. */
  modelPlayback(id: string, at: number, turn?: number): void {
    SpokenLog.push(this.playbacks, id, at);
    if (turn !== undefined) SpokenLog.mark(this.realTurns, id, turn);
  }

  /** The assistant started speaking (any text, fillers included); judged by Vapi turn when queried. */
  assistantStarted(id: string, at: number, turn?: number): void {
    SpokenLog.push(this.starts, id, { at, ...(turn !== undefined ? { turn } : {}) });
    const prev = this.segments.get(id)?.at(-1);
    if (prev && prev.stoppedAt === undefined) prev.stoppedAt = at; // a new start ends the previous segment
    SpokenLog.push(this.segments, id, { at, finals: [], partial: '' });
  }

  /** The assistant stopped speaking (finished or cut off); its final transcript may still follow. */
  assistantStopped(id: string, at: number): void {
    const seg = this.segments.get(id)?.at(-1);
    if (seg && seg.stoppedAt === undefined) seg.stoppedAt = at;
  }

  /** What Vapi says the assistant is saying (partial: replaces the running text) or said (final), for the latest segment. */
  assistantTranscript(id: string, text: string, final: boolean, at = Date.now()): void {
    const seg = this.segments.get(id)?.at(-1);
    const t = text.trim();
    if (!seg || !t) return;
    // A transcript well after the segment's "stopped" means it is speaking again (Vapi pauses between sentences): reopen it.
    if (seg.stoppedAt !== undefined && at - seg.stoppedAt > REOPEN_AFTER_MS) {
      // Words already transcribed are a late re-decode of the tail, not new speech: ignore them.
      const have = toks(seg.finals.join(' '));
      const now = toks(t);
      const seen = now.length > 0 && have.some((_, i) => now.every((w, k) => have[i + k] === w));
      if (seen) return;
      seg.stoppedAt = undefined;
    }
    if (final) {
      seg.finals.push(t);
      seg.partial = '';
    } else seg.partial = t;
  }

  /** The caller cut the assistant off at `at`. */
  interrupted(id: string, at: number): void {
    SpokenLog.push(this.interrupts, id, at);
    const turn = this.starts.get(id)?.at(-1)?.turn;
    SpokenLog.push(this.cutPlaybacks, id, { at, ...(turn !== undefined ? { turn } : {}) });
  }

  /**
   * What the assistant said in the segments playing at or after `since` (those that started then, and those still
   * running or stopped after it: Vapi stacks our output into a turn already playing): their finals joined, plus the
   * latest partial of a segment still running. `open`: the latest such segment has not stopped. `early`: one of them
   * started before `since`, so its text may begin with older speech. `finals`: how many finals.
   */
  spokenSince(id: string, since: number): { text: string; segments: number; interrupted: boolean; open: boolean; early: boolean; finals: number } {
    const segs = (this.segments.get(id) ?? []).filter((g) => g.at >= since || g.stoppedAt === undefined || g.stoppedAt >= since);
    const text = segs.map((g) => [...g.finals, g.partial].filter(Boolean).join(' ')).filter(Boolean).join(' ');
    return {
      text,
      segments: segs.length,
      interrupted: (this.interrupts.get(id) ?? []).some((at) => at >= since),
      open: segs.length > 0 && segs[segs.length - 1]!.stoppedAt === undefined,
      early: segs.some((g) => g.at < since),
      finals: segs.reduce((n, g) => n + g.finals.length, 0),
    };
  }

  /** A speechStarted event whose text was only fillers. */
  fillerOnly(id: string, turn: number): void {
    SpokenLog.mark(this.fillerTurns, id, turn);
  }

  /** The earliest caller speech start at or after `t`, or undefined. */
  firstUserStartAfter(id: string, t: number): number | undefined {
    return this.users.get(id)?.find((at) => at >= t);
  }

  /** The latest caller speech start at or after `t`, or undefined. */
  lastUserStartAfter(id: string, t: number): number | undefined {
    const list = this.users.get(id) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i]! >= t) return list[i];
    return undefined;
  }

  /** Whether model text started playing within [from, to] (an assistant start counts unless its turn was only fillers). */
  modelPlaybackBetween(id: string, from: number, to: number): boolean {
    if ((this.playbacks.get(id) ?? []).some((at) => at >= from && at <= to)) return true;
    // A start, or an interruption of the latest start's turn, counts unless that Vapi turn only played fillers (an unknown turn counts).
    const real = (turn: number | undefined) => turn === undefined || !this.fillerTurns.get(id)?.has(turn) || !!this.realTurns.get(id)?.has(turn);
    return [...(this.starts.get(id) ?? []), ...(this.cutPlaybacks.get(id) ?? [])].some((s) => s.at >= from && s.at <= to && real(s.turn));
  }

  /** Whether any event of either kind was seen for this session. */
  sawEvents(id: string): boolean {
    return this.users.has(id) || this.playbacks.has(id) || this.starts.has(id) || this.interrupts.has(id) || this.userFinals.has(id) || this.userPartials.has(id);
  }
}

const INTERJECTIONS = new Set(['hm', 'hmm', 'mm', 'mmm', 'um', 'uh', 'uhm', 'erm']);
const toks = (text: string): string[] => tokenize(text).map((x) => x.t);

/** `heard` without leading interjections and leading known pieces (fillers, superseded replies), compared by word tokens. */
export function stripLeadingTokens(heard: string[], known: readonly string[]): string[] {
  const forms = known.map((k) => toks(k).filter((w) => !INTERJECTIONS.has(w))).filter((f) => f.length).sort((a, b) => b.length - a.length);
  let h = heard;
  for (let again = true; again && h.length; ) {
    again = false;
    while (h.length && INTERJECTIONS.has(h[0]!)) {
      h = h.slice(1);
      again = true;
    }
    const f = forms.find((x) => x.length <= h.length && x.every((w, i) => h[i] === w));
    if (f) {
      h = h.slice(f.length);
      again = true;
    }
  }
  return h;
}

/**
 * The stored reply cut to what the assistant transcripts say was spoken. Leading fillers, interjections and `known`
 * superseded text are dropped from the spoken text first (by word tokens, so "Let me think." equals "Mm, let me think.").
 * null: keep the reply (every word but at most the last was spoken, or the spoken words do not line up with it: when
 * unsure keep more); '': nothing of it was heard; else the reply up to the recorded word aligned with the last spoken
 * word. The alignment tolerates speech-to-text differences (substitutions, split or merged words).
 */
export function trimByTranscript(recorded: string, spoken: string, known: readonly string[]): string | null {
  const h = stripLeadingTokens(toks(spoken), known);
  if (!h.length) return '';
  const r = toks(recorded);
  if (h.length >= r.length - 1) return null;
  // Edit distance of the heard words to a prefix of the recorded words (the end is free); one row at a time.
  let row = Array.from({ length: r.length + 1 }, (_, j) => j);
  for (let i = 1; i <= h.length; i++) {
    const next = [i];
    for (let j = 1; j <= r.length; j++) {
      next[j] = Math.min(row[j - 1]! + (h[i - 1] === r[j - 1] ? 0 : 1), row[j]! + 1, next[j - 1]! + 1);
    }
    row = next;
  }
  let at = 1;
  for (let j = 1; j <= r.length; j++) {
    if (row[j]! < row[at]! || (row[j] === row[at] && Math.abs(j - h.length) < Math.abs(at - h.length))) at = j;
  }
  if (row[at]! * 2 > h.length || at >= r.length - 1) return null;
  return cutAfterWords(recorded, at);
}
