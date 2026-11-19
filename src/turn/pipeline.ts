import { createHash } from 'node:crypto';
import type { Branch, Session, Turn } from '../tree/types.js';
import { appendTurn, getBranch, NEW_NAME, renameBranch, ROOT_NAME } from '../tree/tree.js';
import { buildContext } from '../tree/context.js';
import { effectiveHistory, inheritedMergeDigests, withoutMetaExchanges } from '../tree/history.js';
import { buildRouteInput } from '../route/input.js';
import type { RouteDecision, Router } from '../route/types.js';
import type { Responder } from '../reply/responder.js';
import { mergeNamePrompt, NAME_MAX, type Namer } from '../reply/namer.js';
import { fallbackDigest, type Digester } from '../reply/digest.js';
import { REPLY_ERROR } from '../reply/copy.js';
import { FillerPicker } from '../reply/filler.js';
import type { TraceStore } from '../trace.js';
import { SentenceChunker } from './sentences.js';
import { applyDecision, type Applied } from './apply.js';

export interface TurnDeps {
  router: Router;
  responder: Responder;
  namer: Namer;
  /** Digests for compare and merge; without one the fallback digest is used. */
  digester?: Digester;
  filler?: FillerPicker;
  traces: TraceStore;
  now?: () => number;
}

export interface TurnResult {
  reply: string;
  decision: RouteDecision;
  branchId: string;
  /** The turn was interrupted before anything was delivered and undone: it must leave no trace. */
  rolledBack?: boolean;
  /** The model gave no usable reply: REPLY_ERROR was spoken and nothing was recorded. */
  failed?: boolean;
}

/** How long to wait for the first sentence before speaking a filler. */
const FILLER_DELAY_MS = 250;
/**
 * When the previous reply already opened with a filler: wait longer instead of skipping. Ordinary replies reach their
 * first sentence 0.9-1.5 s after routing (measured 2026-11-16), so 2 s fires only for the slow ones (compare, merge,
 * long merged context: 4-5 s of thinking) and does not land just before a normal answer.
 */
export const FILLER_AFTER_FILLER_DELAY_MS = 2000;
/**
 * How long compare and merge wait for a thread digest before using the fallback digest. A Claude digest takes
 * about 4 s, so waiting for it delayed those replies by as much; a late digest still fills the cache (and a
 * merged branch's notes) for the turns after.
 */
export const DIGEST_WAIT_MS = 300;
/** Total local deadline for one reply (typed and voice): a stalled model stream must not hold the session lock. */
export const REPLY_DEADLINE_MS = 15000;
const defaultFiller = new FillerPicker();
/** Sessions whose previous reply opened with a filler: the next ordinary reply skips it, so fillers are not on every turn. */
const fillerLastTurn = new WeakSet<Session>();

/** Resolves when the signal aborts (never, without a signal). */
function aborted(signal?: AbortSignal): Promise<'aborted'> {
  return new Promise((res) => {
    if (!signal) return;
    if (signal.aborted) return res('aborted');
    signal.addEventListener('abort', () => res('aborted'), { once: true });
  });
}

interface Snapshot {
  branches: Session['branches']; turns: Session['turns']; currentBranchId: string; counters: Session['counters'];
  awaitingSetAside?: Session['awaitingSetAside']; pendingMergeOffer?: Session['pendingMergeOffer']; pendingMerge?: Session['pendingMerge'];
}

/** Puts the session back as it was before a turn. Revision stays monotonic so clients and speculation caches see a change. */
function restoreSnapshot(s: Session, snapshot: Snapshot, keepCounters = false): void {
  const revision = s.revision + 1;
  const counters = s.counters;
  s.branches = snapshot.branches;
  s.turns = snapshot.turns;
  s.currentBranchId = snapshot.currentBranchId;
  s.counters = keepCounters ? counters : snapshot.counters;
  if (snapshot.awaitingSetAside) s.awaitingSetAside = snapshot.awaitingSetAside;
  else delete s.awaitingSetAside;
  if (snapshot.pendingMergeOffer) s.pendingMergeOffer = snapshot.pendingMergeOffer;
  else delete s.pendingMergeOffer;
  if (snapshot.pendingMerge) s.pendingMerge = snapshot.pendingMerge;
  else delete s.pendingMerge;
  s.revision = revision;
}

/** The last finished turn per session, with the state before it, so a longer version of the same speech can replace it. */
interface UndoRecord {
  snapshot: Snapshot; userText: string; lastTurnId: string; branchId: string;
  /** When the request for this turn arrived. */
  requestAt: number;
  /** Whether a filler was written for this turn, or an earlier attempt at the same speech (that this turn undid) already spoke one. */
  filler: boolean;
  /** When the first real (non-filler) sentence was emitted; undefined when none was. */
  replyAt?: number;
  /** The recorded reply text, '' when none. */
  reply: string;
  /** When the first filler or sentence went out (server clock, like webhook receipt times); undefined when none did. */
  firstEmitAt?: number;
}
const undoRecords = new WeakMap<Session, UndoRecord>();

/**
 * The text of the last turn run on this session when it is still the newest thing on the session (nothing was
 * recorded or switched since), else undefined.
 */
export function lastTurnText(s: Session): string | undefined {
  const rec = undoRecords.get(s);
  if (!rec || s.currentBranchId !== rec.branchId || s.turns.at(-1)?.id !== rec.lastTurnId) return undefined;
  return rec.userText;
}

/**
 * Undoes the last turn completely (its branch operation, user turn and reply) so the same speech can be run again
 * with more words. Counters are kept so ids are never reused. Returns false (nothing changed) when the last turn
 * is no longer the newest thing on the session. The caller holds the session lock.
 */
export function undoLastTurn(s: Session): { filler: boolean; reply: string } | null {
  const rec = undoRecords.get(s);
  if (!rec || lastTurnText(s) === undefined) return null;
  undoRecords.delete(s);
  restoreSnapshot(s, rec.snapshot, true);
  return { filler: rec.filler, reply: rec.reply };
}

/** The last turn's undo record while it is still the newest thing on the session (same rule as `lastTurnText`). */
export function lastUndoRecord(s: Session): Readonly<UndoRecord> | undefined {
  return lastTurnText(s) === undefined ? undefined : undoRecords.get(s);
}

const DIGEST_CACHE_MAX = 200;
interface DigestCache { done: Map<string, string>; inflight: Map<string, Promise<string | undefined>> }
const digestCaches = new WeakMap<Digester, DigestCache>();

/** What a branch's digest is made from: its effective turns and the merge digests it inherits (corrections are marked on the turns). */
function digestInput(s: Session, id: string): { turns: Turn[]; notes: string[] } {
  return { turns: withoutMetaExchanges(effectiveHistory(s, id).turns), notes: inheritedMergeDigests(s, id) };
}

/** Cache key part: changes whenever any effective turn's id, role, kind or text, the notes or the name change. */
function fingerprint(name: string, input: { turns: Turn[]; notes: string[] }): string {
  const json = JSON.stringify([name, input.turns.map((t) => [t.id, t.role, t.kind ?? '', t.text]), input.notes]);
  return createHash('sha1').update(json).digest('hex');
}

/**
 * Starts (or joins) the digest of one branch, keyed by a fingerprint of its effective history. Never rejects: a
 * failed or empty digest resolves undefined and is not cached. Not tied to a turn's abort signal, so a digest
 * started for an interrupted turn still serves the next one.
 */
function startDigest(digester: Digester, s: Session, id: string, name: string): Promise<string | undefined> {
  let cache = digestCaches.get(digester);
  if (!cache) digestCaches.set(digester, (cache = { done: new Map(), inflight: new Map() }));
  const c = cache;
  const input = digestInput(s, id);
  if (!input.turns.length) return Promise.resolve(undefined);
  const key = `${s.id}|${id}|${fingerprint(name, input)}`;
  const hit = c.done.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = c.inflight.get(key);
  if (running) return running;
  const p = Promise.resolve()
    .then(() => digester.digest(name, input.turns, undefined, input.notes))
    .then((t) => t.trim() || undefined, () => undefined)
    .then((text) => {
      c.inflight.delete(key);
      if (text !== undefined) {
        c.done.delete(key);
        c.done.set(key, text);
        if (c.done.size > DIGEST_CACHE_MAX) c.done.delete(c.done.keys().next().value!);
      }
      return text;
    });
  c.inflight.set(key, p);
  return p;
}

/** Computes a branch's digest in the background so a later compare or merge finds it cached. */
function warmDigest(digester: Digester | undefined, s: Session, id: string): void {
  const b = getBranch(s, id);
  if (digester && b) void startDigest(digester, s, id, b.name);
}

/** Diagnostics: what the turn did to the tree, which can differ from the router's op (a "yes" accepting a merge offer). */
function appliedLabel(applied: Applied, decision: RouteDecision, fromBranchId: string): string {
  if (applied.merged) return 'merge';
  if (applied.forked) return 'fork';
  if (applied.kind === 'correction') return 'correct';
  if (applied.scratchCommand) return 'scratch';
  if (applied.replyKind === 'compare' || applied.replyKind === 'recap') return applied.replyKind;
  if (applied.branchId !== fromBranchId) return decision.op.kind === 'park' ? 'park' : 'switch';
  if (applied.prefix === null && applied.instruction === null) return 'continue';
  return decision.op.kind;
}

const TIMED_OUT = Symbol('timed out');

/**
 * One `Thread "<name>": <digest>` note per branch, concurrently, after at most `waitMs`: a digest that is not
 * ready by then (or failed) uses the fallback digest. `late` resolves to the full notes once every slow digest
 * has finished (only when one was late).
 */
async function digestNotes(
  digester: Digester | undefined,
  s: Session,
  sources: { id: string; name: string }[],
  waitMs: number,
): Promise<{ notes: string[]; late?: Promise<string[]> }> {
  const pending = sources.map(({ id, name }) => (digester ? startDigest(digester, s, id, name) : Promise.resolve(undefined)));
  const toNotes = (texts: (string | undefined)[]) =>
    sources.map(({ id, name }, i) => {
      const input = digestInput(s, id);
      return `Thread "${name}": ${texts[i] ?? fallbackDigest(name, input.turns, input.notes).slice(name.length + 2)}`;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((res) => (timer = setTimeout(res, waitMs, TIMED_OUT)));
  const quick = await Promise.all(pending.map((p) => Promise.race([p, timeout])));
  clearTimeout(timer);
  const notes = toNotes(quick.map((q) => (q === TIMED_OUT ? undefined : q)));
  if (!quick.includes(TIMED_OUT)) return { notes };
  return { notes, late: Promise.all(pending).then(toNotes) };
}

/**
 * Renames `branch` once `named` resolves, unless it was renamed meanwhile, the turn was rolled back (the branch
 * object was replaced) or the session ended. With `unique`, a name another branch already has is not used.
 */
function nameLater(s: Session, branch: Branch, named: Promise<string | null>, opts: { unique?: boolean; fallback?: string } = {}): void {
  const from = branch.name;
  void named.catch(() => null).then((name) => {
    if (s.ended || getBranch(s, branch.id) !== branch || branch.name !== from) return;
    const taken = (n: string) => opts.unique && Object.values(s.branches).some((o) => o !== branch && o.name.toLowerCase() === n.toLowerCase());
    const pick = [name, opts.fallback].find((n): n is string => !!n && !taken(n));
    if (!pick || pick === from) return;
    renameBranch(s, branch.id, pick);
    s.revision += 1; // a late rename is a visible change: clients and the film log see it at once
  });
}

/** "A + B", or "A1 + B1" (first words) when that is too long for the map. */
function mergedFallback(a: string, b: string): string {
  const full = `${a} + ${b}`;
  if (full.length <= NAME_MAX) return full;
  return `${a.split(/\s+/)[0]} + ${b.split(/\s+/)[0]}`.slice(0, NAME_MAX).trim();
}

/** Starts the background names a decision needs: a new fork, the root at its first fork, a merged branch. */
function startNaming(namer: Namer, s: Session, applied: Applied, text: string): void {
  const branch = getBranch(s, applied.branchId);
  if (!branch) return;
  if (applied.forked && branch.name === NEW_NAME) {
    nameLater(s, branch, namer.name(text));
    // The root keeps its placeholder until there is a second thread to tell it apart from.
    const parent = branch.parentId ? getBranch(s, branch.parentId) : undefined;
    if (parent?.origin === 'root' && parent.name === ROOT_NAME) {
      const said = s.turns.filter((t) => t.branchId === parent.id && t.role === 'user' && !t.scratched && t.text.trim() !== '').slice(-3);
      if (said.length) nameLater(s, parent, namer.name(said.map((t) => t.text.trim()).join(' ')), { unique: true });
    }
  }
  if (applied.merged) {
    // Named from the source names, not from the "combine them" utterance, and never the same as another thread.
    const [a, b] = applied.merged;
    nameLater(s, branch, namer.name(mergeNamePrompt(a, b)), { unique: true, fallback: mergedFallback(a, b) });
  }
}

/**
 * Runs one turn. The caller holds the session lock.
 * `onSentence` is called per completed sentence (the prefix is the first). Only sentences that were
 * delivered are recorded: an abort, before or during delivery, drops that sentence and everything after,
 * and is never an error.
 */
export async function runTurn(
  deps: TurnDeps,
  s: Session,
  text: string,
  opts: { onSentence?: (sentence: string) => void; signal?: AbortSignal; decision?: RouteDecision;
    /** No filler timer at all (an earlier attempt for the same speech already spoke one). */
    noFiller?: boolean;
    /** Called right after the decision is applied (still under the caller's lock), before any reply is spoken. */
    onDecision?: (decision: RouteDecision) => void } = {},
): Promise<TurnResult> {
  const now = deps.now ?? Date.now;
  const { signal } = opts;
  const trace = deps.traces.current(s.id, 'llm');
  trace.llmRequestAt ??= now();

  const decision = opts.decision ?? (await deps.router.route(buildRouteInput(s, text)));
  trace.routeMs = opts.decision ? 0 : decision.ms; // a supplied decision was routed earlier (speculationHit marks it)
  trace.routeBy = decision.by;
  trace.op = decision.op.kind;
  trace.routeReason = decision.reason;
  if (decision.raw) trace.routeRaw = decision.raw;

  // Aborted while routing: nothing was said or changed.
  if (signal?.aborted) return { reply: '', decision, branchId: s.currentBranchId };

  const snapshot: Snapshot = structuredClone({ branches: s.branches, turns: s.turns, currentBranchId: s.currentBranchId, counters: s.counters, awaitingSetAside: s.awaitingSetAside, pendingMergeOffer: s.pendingMergeOffer, pendingMerge: s.pendingMerge });
  const applied = applyDecision(s, decision, now(), text);
  const { branchId } = applied;
  trace.appliedOp = appliedLabel(applied, decision, snapshot.currentBranchId);
  opts.onDecision?.(decision);
  // A branch the user just left stops changing: digest it now so a compare or merge later does not wait.
  if (branchId !== snapshot.currentBranchId) warmDigest(deps.digester, s, snapshot.currentBranchId);
  // Named once something is delivered (the turn can no longer roll back), not after the whole reply, so the map
  // does not show a placeholder name all through the reply.
  let named = false;
  const nameOnce = () => {
    if (named) return;
    named = true;
    startNaming(deps.namer, s, applied, text);
  };
  const userTurn = appendTurn(s, branchId, 'user', text, now(), applied.kind);
  if (applied.scratchCommand) userTurn.scratched = true;

  const emitted: string[] = [];
  let fillerReached = false;
  /** Whether the previous reply opened with a filler (restored if this turn is cut off, so an unheard turn does not count). */
  let prevFiller = false;
  let firstEmitAt: number | undefined;
  const emit = (sentence: string): boolean => {
    if (signal?.aborted) return false;
    firstEmitAt ??= Date.now();
    trace.firstEmitAt ??= firstEmitAt;
    opts.onSentence?.(sentence);
    if (signal?.aborted) return false; // aborted while delivering: not delivered
    emitted.push(sentence);
    nameOnce();
    trace.firstChunkAt ??= now();
    trace.firstSentenceAt ??= now();
    return true;
  };

  let replyFailed = false;
  let alive = !signal?.aborted;
  if (alive && applied.prefix) alive = emit(applied.prefix);
  const modelSentences = () => emitted.length - (applied.prefix ? 1 : 0);

  if (alive && !applied.skipReply) {
    const chunker = new SentenceChunker();
    const abortP = aborted(signal);
    // Local deadline: aborts the upstream stream (the responder gets this signal too) and counts as a reply failure.
    const deadline = new AbortController();
    let deadlineHit = false;
    const deadlineTimer = setTimeout(() => { deadlineHit = true; deadline.abort(); }, REPLY_DEADLINE_MS);
    const deadlineP = aborted(deadline.signal).then(() => 'deadline' as const);
    const replySignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let iter: AsyncIterator<string> | undefined;
    let failed = false;
    // Emitted but never recorded: a filler would pollute the context. Only for plain replies (no prefix, no instruction).
    // Compare and merge also arm it: the digests are on the critical path. An ordinary reply whose previous reply
    // opened with a filler waits FILLER_AFTER_FILLER_DELAY_MS instead of skipping it.
    const fillerAfterFiller = fillerLastTurn.has(s);
    prevFiller = fillerAfterFiller;
    fillerLastTurn.delete(s);
    const fillerTimer =
      !opts.noFiller && !applied.prefix && (applied.digestOf || !applied.instruction)
        ? setTimeout(() => {
            if (signal?.aborted || trace.firstSentenceAt !== undefined) return;
            // The SSE writer frames it with a flush tag (voiceChunk); no trailing-space trick.
            firstEmitAt ??= Date.now();
            trace.firstEmitAt ??= firstEmitAt;
            opts.onSentence?.((deps.filler ?? defaultFiller).pick(/\?\s*$/.test(text)));
            fillerReached = true;
            fillerLastTurn.add(s);
            nameOnce();
            if (signal?.aborted) return; // aborted while delivering: not delivered
            trace.filler = true;
            trace.fillerAt = now();
          }, applied.digestOf || !fillerAfterFiller ? FILLER_DELAY_MS : FILLER_AFTER_FILLER_DELAY_MS)
        : undefined;
    try {
      let notes: string[] | undefined;
      let late: Promise<string[]> | undefined;
      if (applied.digestOf) {
        const got = await Promise.race([digestNotes(deps.digester, s, applied.digestOf, DIGEST_WAIT_MS), abortP]);
        if (got === 'aborted') throw new Error('aborted'); // not an error: handled below like any abort
        ({ notes, late } = got);
      }
      // A merge's digests are kept on the branch for every later reply; a compare's note is per turn.
      const mergedBranch = applied.merged ? getBranch(s, branchId) : undefined;
      if (mergedBranch && notes) {
        mergedBranch.mergeDigests = notes;
        // The fallback notes this reply used are replaced by the real digests once they arrive.
        const used = notes;
        void late?.then((better) => {
          const b = getBranch(s, branchId);
          if (b && !s.ended && b.mergeDigests === used) b.mergeDigests = better;
        });
      }
      const context = buildContext(s, branchId, mergedBranch ? undefined : notes);
      trace.notesChars = [...context.notes, applied.instruction ?? ''].reduce((n, x) => n + x.length, 0);
      trace.contextChars = context.messages.reduce((n, m) => n + m.content.length, 0) + trace.notesChars;
      trace.modelRequestAt = now();
      iter = deps.responder
        .reply({ context, ...(applied.instruction ? { instruction: applied.instruction } : {}), onStop: (r, u) => {
          trace.modelStopReason = r;
          trace.modelStopCategory = u?.stopCategory;
          if (u?.outputTokens !== undefined) trace.modelOutputTokens = u.outputTokens;
          trace.modelThinkingTokens = u?.thinkingTokens;
          trace.modelInputTokens = u?.inputTokens;
          trace.modelCacheReadTokens = u?.cacheReadTokens;
          trace.modelCacheWriteTokens = u?.cacheWriteTokens;
          trace.modelFirstEventAt = u?.firstEventAt;
          trace.modelThinkingStartAt = u?.thinkingStartAt;
          trace.modelFirstTextAt = u?.firstTextAt;
        } }, replySignal)
        [Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iter.next(), abortP, deadlineP]);
        if (next === 'deadline') throw new Error('reply deadline');
        if (next === 'aborted' || next.done) break;
        for (const sentence of chunker.push(next.value)) {
          if (!emit(sentence)) {
            alive = false;
            break;
          }
        }
        if (!alive) break;
      }
    } catch {
      // Not an abort (that is handled below): any other throw, including a truncated stream, is a failure.
      failed = true;
    }
    clearTimeout(fillerTimer);
    clearTimeout(deadlineTimer);
    if (deadlineHit && !signal?.aborted) trace.modelStopReason ??= 'deadline';
    if (!deadline.signal.aborted) deadline.abort(); // reply finished: release the listeners tied to this signal
    if (signal?.aborted) alive = false;
    // A failure the stream never reported a stop reason for (an SDK/network error): still visible in the trace.
    if (failed && !signal?.aborted) trace.modelStopReason ??= 'error';
    if (signal?.aborted) {
      // A cut-off turn's filler was not heard as "the previous reply": put the earlier state back.
      if (prevFiller) fillerLastTurn.add(s);
      else fillerLastTurn.delete(s);
    }
    if (!alive) void Promise.resolve(iter?.return?.()).catch(() => {});
    else {
      // Clean end: keep the whole tail. Error or truncation: keep only a finished sentence, never a broken fragment.
      const rest = failed ? chunker.finishComplete() : chunker.flush();
      if (rest) emit(rest);
      // A stream that ends with no visible text (refusal, thinking exhausting max_tokens) is a failure too.
      // The apology is spoken but never stored (not in `emitted`), so the next turn does not see it as the reply.
      if (modelSentences() === 0 && !signal?.aborted) {
        firstEmitAt ??= Date.now();
        trace.firstEmitAt ??= firstEmitAt;
        opts.onSentence?.(REPLY_ERROR);
        if (!signal?.aborted) {
          replyFailed = true;
          trace.firstChunkAt ??= now();
        }
      }
    }
  }
  trace.firstChunkAt ??= now();
  trace.doneAt = now();

  if (replyFailed) {
    // Nothing the model said was delivered: record no reply. A merge keeps its tree change (branch, digests, user turn)
    // so later replies still see both sources; every other op is undone so "say it again" truly retries.
    undoRecords.delete(s);
    if (!applied.merged) {
      restoreSnapshot(s, snapshot, true);
      // The rolled-back turn does not count as "the previous reply": put the earlier filler state back (as the abort path does).
      if (prevFiller) fillerLastTurn.add(s);
      else fillerLastTurn.delete(s);
    }
    return { reply: REPLY_ERROR, decision, branchId: s.currentBranchId, failed: true, rolledBack: !applied.merged };
  }

  const reply = emitted.join(' ');
  if (signal?.aborted && emitted.length === 0 && !fillerReached) {
    // Interrupted before anything was delivered: the user will resend, so this turn must leave no trace.
    restoreSnapshot(s, snapshot);
    return { reply: '', decision, branchId: s.currentBranchId, rolledBack: true };
  }
  if (reply) {
    const replyTurn = appendTurn(s, branchId, 'assistant', reply, now(), applied.replyKind);
    if (applied.scratchCommand) replyTurn.scratched = true;
    // A compare is often followed by "combine them": have the current branch's digest ready for that merge.
    if (applied.replyKind === 'compare') warmDigest(deps.digester, s, branchId);
  }
  nameOnce();
  undoRecords.set(s, { snapshot, userText: text, lastTurnId: s.turns.at(-1)!.id, branchId, requestAt: trace.llmRequestAt ?? now(), filler: fillerReached || !!opts.noFiller, ...(trace.firstSentenceAt !== undefined ? { replyAt: trace.firstSentenceAt } : {}), reply, ...(opts.onSentence && firstEmitAt !== undefined ? { firstEmitAt } : {}) }); // voice-streamed turns only: typed replies are never trimmed
  return { reply, decision, branchId };
}
