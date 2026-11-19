import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { MAX_TEXT, publishDecisions, type Deps } from '../server.js';
import { lastTurnText, lastUndoRecord, runTurn, undoLastTurn } from '../turn/pipeline.js';
import { SentenceChunker } from '../turn/sentences.js';
import { pathTurns } from '../tree/tree.js';
import type { Session } from '../tree/types.js';
import { FILLERS } from '../reply/filler.js';
import { currentTrace, logKeysOnce } from './events.js';
import { stripLeadingTokens, trimByTranscript } from './spoken.js';
import { bargeInText, captureMessages, contentText, extendsText, spokenPrefix, stripLeading, tokenize, utteranceText } from './reconcile.js';

type Lock = <T>(id: string, fn: () => Promise<T>) => Promise<T>;

/**
 * One complete sentence as an SSE content piece: trailing whitespace trimmed, then Vapi's `<flush />` tag once, so
 * the voice chunker does not hold a finished sentence until the next text arrives. Transport framing only; the tag
 * is never stored, recorded or sent to the model. Use only for non-empty complete sentences.
 */
export function voiceChunk(sentence: string): string {
  return `${sentence.trimEnd()} <flush /> `;
}

export const UNBOUND_REPLY = "This call isn't linked to a session yet.";

export function secretOk(secret: string, req: Request): boolean {
  const candidates = [req.header('x-vapi-secret'), req.header('authorization')?.replace(/^Bearer /, '')];
  const want = Buffer.from(secret);
  return candidates.some((c) => {
    if (!c) return false;
    const got = Buffer.from(c);
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

/**
 * All user messages after the last assistant message with non-empty content, joined by single spaces.
 * Held speech arrives as several user messages around empty assistant replies.
 */
export function userTextSinceLastAssistant(body: unknown): string {
  const msgs = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(msgs)) return '';
  const parts: string[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: unknown; content?: unknown } | null;
    if (!m) continue;
    const text = contentText(m.content).trim();
    if (m.role === 'assistant' && text) break;
    if (m.role === 'user' && text) parts.unshift(text);
  }
  return parts.join(' ').slice(0, MAX_TEXT);
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();

type ReplyStatus = 'none' | 'spoken' | 'cut' | 'unspoken' | 'unknown';

const messagesOf = (body: unknown): { role?: unknown; content?: unknown }[] => {
  const msgs = (body as { messages?: unknown })?.messages;
  return Array.isArray(msgs) ? (msgs.filter(Boolean) as { role?: unknown; content?: unknown }[]) : [];
};

/** The text of Vapi's last non-empty assistant message: what it says it spoke last. */
function lastSpoken(body: unknown): string {
  const msgs = messagesOf(body);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== 'assistant') continue;
    const text = contentText(msgs[i]!.content).trim();
    if (text) return text;
  }
  return '';
}

const undoneReplies = new WeakMap<Session, string[]>();

/** The id of the last reply turn a Vapi request produced (streamed or not); typed replies are never trimmed against Vapi's history. */
const voiceReplyTurn = new WeakMap<Session, string>();
const markVoiceReply = (s: Session): void => {
  const rec = lastUndoRecord(s);
  if (rec) voiceReplyTurn.set(s, rec.lastTurnId);
};

/** The user text last handed to a turn, with the part of it that was barge-in words (placed before a cut reply). */
const lastBarge = new WeakMap<Session, { text: string; barge: string }>();

interface PhantomHistoryBoundary {
  snapshot: { role: unknown; content: string }[];
  discarded: Set<number>;
}
const phantomHistoryBoundaries = new WeakMap<Session, PhantomHistoryBoundary>();

/** Apply a phantom boundary only while Vapi still sends the exact observed history that established it. */
function applyPhantomHistoryBoundary(s: Session, body: unknown, retire = true): unknown {
  const boundary = phantomHistoryBoundaries.get(s);
  if (!boundary) return body;
  const raw = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(raw)) return body;
  if (raw.length < boundary.snapshot.length) {
    if (retire) phantomHistoryBoundaries.delete(s);
    return body;
  }
  let messages: unknown[] | undefined;
  for (let i = 0; i < boundary.snapshot.length; i++) {
    const message = raw[i] as { role?: unknown; content?: unknown } | null;
    const seen = boundary.snapshot[i]!;
    const content = contentText(message?.content);
    const discarded = boundary.discarded.has(i);
    if (message?.role !== seen.role || (content !== seen.content && !(discarded && content === ''))) {
      if (retire) phantomHistoryBoundaries.delete(s);
      return body;
    }
    if (discarded && content) {
      messages ??= raw.slice();
      messages[i] = { ...message, content: '' };
    }
  }
  return messages ? { ...(body as Record<string, unknown>), messages } : body;
}

/** Remember only the user-message location that supplied this positively classified partial-only tail. */
function rememberPhantomHistory(s: Session, rawBody: unknown, body: unknown, extra: readonly string[], fromBarge: boolean): void {
  const raw = (rawBody as { messages?: unknown } | null)?.messages;
  const clean = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(raw) || !Array.isArray(clean)) return;
  const msgs = clean as { role?: unknown; content?: unknown }[];
  let lastAssistant = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'assistant' && contentText(msgs[i]!.content).trim()) { lastAssistant = i; break; }
  }
  const indexes = Array.from({ length: msgs.length }, (_, i) => i).filter((i) =>
    msgs[i]?.role === 'user' && (fromBarge ? i < lastAssistant : i > lastAssistant),
  ).reverse();
  for (const index of indexes) {
    const text = contentText(msgs[index]!.content);
    const tokens = tokenize(text);
    if (tokens.length < extra.length || extra.some((word, i) => tokens[tokens.length - extra.length + i]!.t !== word)) continue;
    const previous = phantomHistoryBoundaries.get(s);
    const snapshot = raw.map((message, i) => previous?.discarded.has(i)
      ? previous.snapshot[i]!
      : { role: message?.role, content: contentText(message?.content) });
    const discarded = new Set(previous?.discarded);
    // The previously stored text is already in the session. Replaying any of that user message after the
    // empty phantom completion would route the old turn again, so consume this exact observed message location.
    discarded.add(index);
    phantomHistoryBoundaries.set(s, { snapshot, discarded });
    return;
  }
}

/** A caller who starts talking within this long after the first real sentence went out cannot have heard it yet. */
const HEARD_AFTER_MS = 250;

const sentencesOf = (text: string): string[] => {
  const c = new SentenceChunker();
  const out = c.push(`${text} `);
  const rest = c.flush();
  return rest ? [...out, rest] : out;
};

/** Sentences of the replies undone earlier in this session (the last 5): Vapi may still have them stacked in its messages. */
const undoneSentences = (s: Session): string[] => (undoneReplies.get(s) ?? []).flatMap(sentencesOf);

/** Undoes the last turn and remembers its reply as superseded text. */
function undoAndNote(s: Session): { filler: boolean; reply: string } | null {
  const undo = undoLastTurn(s);
  if (undo?.reply) undoneReplies.set(s, [...(undoneReplies.get(s) ?? []), undo.reply].slice(-5));
  return undo;
}

/**
 * Vapi sends back only what it actually spoke. If its last assistant message is a non-empty strict prefix of the
 * recorded last assistant turn, the reply was cut off: record just the spoken part. Returns what happened to the
 * recorded reply (the path's last turn): spoken in full, cut (and trimmed), never spoken (Vapi's last spoken
 * message is missing, or is an earlier reply), or unknown. Caller holds the session lock.
 */
function trimToSpoken(s: Session, body: unknown): ReplyStatus {
  const spoken = lastSpoken(body);
  const path = pathTurns(s, s.currentBranchId);
  const last = path.at(-1);
  if (!last || last.role !== 'assistant') return 'none';
  const recorded = norm(last.text);
  // A typed reply was displayed in full: Vapi's history says nothing about it. Only a reply produced for a Vapi request
  // may be cut; without an undo record (restored session) keep the fallback.
  const rec = lastUndoRecord(s);
  const trimmable = !(rec && rec.lastTurnId === last.id && voiceReplyTurn.get(s) !== last.id);
  const cut = (text: string): 'cut' | 'spoken' | null => {
    const n = norm(text);
    if (!n) return null;
    if (recorded.startsWith(n)) {
      if (recorded === n) return 'spoken';
      if (!trimmable) return null;
      last.text = text;
      return 'cut';
    }
    // Same words, formatted differently (digits, punctuation): compare normalized.
    // No revision bump on a trim: speculated routing decisions are keyed by revision, so a bump would discard them.
    const m = spokenPrefix(recorded, n);
    if (!m) return null;
    if (m.complete) return 'spoken';
    if (!trimmable) return null;
    last.text = m.text;
    return 'cut';
  };
  if (!norm(spoken)) return 'unspoken'; // nothing was spoken at all
  // The raw text first: a reply may itself begin with a filler word.
  const raw = cut(spoken);
  if (raw) return raw;
  // A filler (or a reply undone earlier) is spoken but never recorded, so Vapi's message is "filler + partial reply":
  // drop every such leading piece and retry. Case-insensitive, accepts "..." for the ellipsis, ends at a word boundary.
  const spokenNorm = norm(spoken);
  const rest = stripLeading(spokenNorm, [...FILLERS, ...undoneSentences(s)]);
  if (rest !== spokenNorm) {
    const r = cut(rest);
    if (r) return r;
  }
  // Vapi's last spoken message is an earlier reply: this one was never spoken.
  // Compared as spoken and with every leading filler and interjection stripped ("Okay. Hm, ..." heard before an earlier reply).
  const n = norm(spoken);
  const heard = stripLeadingTokens(tokenize(n).map((x) => x.t), FILLERS);
  const earlier = (t: { role: string; text: string }): boolean => {
    if (t.role !== 'assistant') return false;
    if (norm(t.text).startsWith(n) || spokenPrefix(norm(t.text), n)) return true;
    const r = tokenize(t.text).map((x) => x.t);
    return heard.length > 0 && heard.length <= r.length && heard.every((w, i) => r[i] === w);
  };
  if (path.slice(0, -1).some(earlier)) return 'unspoken';
  // Vapi's only assistant message so far is its opening line, which is never recorded as a turn: nothing of ours was spoken.
  if (messagesOf(body).filter((m) => m.role === 'assistant' && contentText(m.content).trim()).length === 1) return 'unspoken';
  return 'unknown';
}

/**
 * Words the user said over the assistant: Vapi may place them just before its interrupted assistant message,
 * after the user turn already recorded. Read-only.
 */
function bargeIn(s: Session, body: unknown): string {
  const spoken = norm(lastSpoken(body));
  if (!spoken) return '';
  const path = pathTurns(s, s.currentBranchId).filter((t) => !t.scratched);
  // The raw text first (a reply may itself begin with a filler), then with every leading filler / superseded piece
  // stripped: Vapi's message can be "filler + partial reply" while the stored reply holds neither.
  const stripped = stripLeading(spoken, [...FILLERS, ...undoneSentences(s)]);
  let at = -1;
  for (const cand of stripped && stripped !== spoken ? [spoken, stripped] : [spoken]) {
    for (let i = path.length - 1; i >= 0 && at < 0; i--) {
      if (path[i]!.role === 'assistant' && (norm(path[i]!.text).startsWith(cand) || spokenPrefix(norm(path[i]!.text), cand))) at = i;
    }
    if (at >= 0) break;
  }
  const prior = path.slice(0, Math.max(at, 0)).reverse().find((t) => t.role === 'user');
  return at < 0 || !prior ? '' : bargeInText(messagesOf(body), prior.text);
}

/**
 * Cuts the last recorded reply to what the webhook's assistant transcripts say was spoken (and drops it when none of it
 * was heard). Acts only when that reply is the newest thing on the session, with evidence: `interrupt` needs the caller
 * to have cut the assistant off; `end` also accepts a reply still being spoken, or none heard at all well after it went
 * out. Never bumps the revision for a cut (like `trimToSpoken`). Caller holds the session lock.
 */
export function trimLastReplyToSpoken(s: Session, deps: Pick<Deps, 'spoken'>, mode: 'interrupt' | 'end'): void {
  const turn = pathTurns(s, s.currentBranchId).at(-1);
  const rec = lastUndoRecord(s);
  if (!turn || turn.role !== 'assistant' || !rec || rec.lastTurnId !== turn.id || rec.firstEmitAt === undefined) return;
  const sp = deps.spoken.spokenSince(s.id, rec.firstEmitAt);
  if (mode === 'interrupt') {
    if (!(sp.interrupted && sp.segments > 0)) return;
  } else if (sp.segments > 0) {
    if (!(sp.interrupted || sp.open)) return;
  } else if (!(deps.spoken.sawEvents(s.id) && Date.now() - rec.firstEmitAt > 2000)) return;
  // Older replies may be stacked ahead of this one inside a Vapi turn that was already playing.
  const earlier = pathTurns(s, s.currentBranchId).filter((t) => t.role === 'assistant').slice(-3, -1).flatMap((t) => sentencesOf(t.text));
  const cut = trimByTranscript(turn.text, sp.text, [...FILLERS, ...undoneSentences(s), ...earlier]);
  if (cut === null) return;
  // Dropping the whole reply needs strong evidence: transcripts show the assistant spoke, only other things, from a turn
  // that began with this reply (never one that was already playing, whose transcripts may lag).
  if (cut === '' && sp.segments > 0 && (sp.early || !sp.text.trim())) return;
  const fromWords = words(turn.text).length;
  if (cut === '') {
    const i = s.turns.lastIndexOf(turn);
    if (i < 0) return;
    s.turns.splice(i, 1);
    s.revision += 1;
  } else turn.text = cut;
  console.log(JSON.stringify({ sessionId: s.id, event: 'reply-trim', mode, fromWords, toWords: words(cut).length }));
}

/** The phantom guard's limits: at most this many new words, found in order within this many tail words of the stored user turn. */
const PHANTOM_MAX_WORDS = 4;
const PHANTOM_TAIL_TOKENS = 10;
/** A real final transcript is waited for this long before a request is judged phantom (the smallest final-to-request margin seen was 73 ms). */
const PHANTOM_GRACE_MS = 400;

/** Whether the words of `needle` occur in `hay` in order (not necessarily next to each other). */
function inOrder(needle: readonly string[], hay: readonly string[]): boolean {
  let i = 0;
  for (const w of hay) if (i < needle.length && w === needle[i]) i++;
  return i === needle.length;
}

/**
 * Phantom-tail guard (live call 1, section 1.5 of the debug notes). Vapi's speech-to-text sometimes emits, about 4 s
 * after the caller finished, a late interim result that re-decodes the tail of their own last sentence ("Kyoto 3").
 * It never becomes a final transcript and no speech start comes with it, but it cuts the reply that is playing and
 * Vapi sends a request whose user text is the previous text plus those words. Left alone, the phantom undoes the good
 * turn (growing-utterance) or becomes a user turn of its own.
 *
 * Classification and resuming are separate. It classifies a request as a phantom only when ALL hold: webhook events
 * were seen; the last recorded thing is our reply to the previous request; the webhook showed the phantom's own partial
 * transcript after the previous request and its words equal the new words; no user final transcript and no user speech
 * start arrived since the previous request (after a 400 ms wait for a late final, only once every other condition
 * already holds); and the new words are 1-4 tokens that occur, in order, within the last 10 tokens of the stored
 * previous user turn (tokenize folds case, punctuation and numbers, so "3" equals "three"). The new words are the same
 * candidate text reconciliation would route: Vapi's user text since its last assistant message, plus words it placed
 * before a completed assistant message (`bargeIn`), so all three request shapes are covered (the words appended to the
 * previous user message after an old assistant message, as a new user message after the completed reply, or appended
 * before the completed reply). A confirmed phantom stores and undoes nothing. If the reply was cut (a `user-interrupted`
 * since it began; with stopSpeakingPlan.numWords 2 a one-word phantom may not interrupt) the answer resumes it from
 * the first word the caller did not hear (the stored reply as generated; when the heard part cannot be aligned, its
 * last sentence); if it was not cut the answer is empty: the reply stays as spoken. Returns that text ('' = say
 * nothing), or null when it is not a phantom.
 * Runs before the growing-utterance undo and before any trim, so a phantom never undoes or shortens the previous reply.
 *
 * What protects a real answer (this is NOT "no information is lost": a one-word choice such as "Kyoto" repeats words
 * already in the stored turn but is new information, so dropping it would be wrong): (1) the guard needs positive
 * evidence of the phantom, its own partial that matched the new words and never became a final; a webhook that lags
 * loses the partial as well, which switches the guard off; (2) any user final or speech start since the previous
 * request disables it (every real request in call 1 had a final before it, 15 of 15, but that is observed, not
 * guaranteed, hence the 400 ms wait); (3) a real answer that does have a partial and a final more than 400 ms late
 * after the request, and no speech start, is still the residual risk. With no webhook events the guard never fires.
 * Caller holds the session lock.
 */
export async function phantomTail(s: Session, rawBody: unknown, deps: Pick<Deps, 'spoken'>): Promise<string | null> {
  const body = applyPhantomHistoryBoundary(s, rawBody);
  const rec = lastUndoRecord(s);
  if (!rec || !rec.reply.trim() || rec.firstEmitAt === undefined || !deps.spoken.sawEvents(s.id)) return null;
  const path = pathTurns(s, s.currentBranchId);
  const last = path.at(-1);
  if (!last || last.role !== 'assistant' || last.id !== rec.lastTurnId) return null;
  const quiet = () => deps.spoken.userFinalAfter(s.id, rec.requestAt) === undefined && deps.spoken.lastUserStartAfter(s.id, rec.requestAt) === undefined;
  if (!quiet()) return null;
  const barge = bargeIn(s, body);
  const now = tokenize(joinText(barge, userTextSinceLastAssistant(body))).map((x) => x.t);
  const prior = tokenize(rec.userText).map((x) => x.t);
  const extra = now.length > prior.length && prior.every((w, i) => now[i] === w) ? now.slice(prior.length) : now;
  if (extra.length < 1 || extra.length > PHANTOM_MAX_WORDS || !inOrder(extra, prior.slice(-PHANTOM_TAIL_TOKENS))) return null;
  const partial = deps.spoken.userPartialAfter(s.id, rec.requestAt);
  const heard = partial ? tokenize(partial.text).map((x) => x.t) : [];
  if (heard.length !== extra.length || heard.some((w, i) => w !== extra[i])) return null;
  for (const end = Date.now() + PHANTOM_GRACE_MS; Date.now() < end && quiet(); ) await new Promise((r) => setTimeout(r, 25));
  if (!quiet()) return null;
  // Interruption and transcript events may arrive during the grace period. Use the same fresh evidence both to decide
  // whether to resume and to calculate the resume offset.
  const fresh = deps.spoken.spokenSince(s.id, rec.firstEmitAt);
  rememberPhantomHistory(s, rawBody, body, extra, !!barge);
  console.log(JSON.stringify({ sessionId: s.id, event: 'phantom-tail', words: extra.length, interrupted: fresh.interrupted }));
  if (!fresh.interrupted) return ''; // the reply was not cut: nothing to resume, nothing recorded, the previous turn and reply stay
  const earlier = path.filter((t) => t.role === 'assistant').slice(-3, -1).flatMap((t) => sentencesOf(t.text));
  const reply = rec.reply.trim();
  const cut = trimByTranscript(reply, fresh.text, [...FILLERS, ...undoneSentences(s), ...earlier]);
  const undetermined = cut === null || (cut === '' && (fresh.segments === 0 || fresh.early || !fresh.text.trim()));
  last.text = rec.reply; // an earlier silent request may have trimmed it: the stored reply is what was spoken in total once resumed
  if (undetermined) return sentencesOf(reply).at(-1) ?? reply;
  return reply.slice(cut!.length).replace(/^[\s,;:.!?\u2014\u2013]+/, '');
}

const joinText = (...p: string[]) => p.filter(Boolean).join(' ');
const requestUserText = (s: Session, body: unknown) => joinText(bargeIn(s, body), userTextSinceLastAssistant(body)).slice(0, MAX_TEXT);

/**
 * The user text for this request, with the session made consistent with what Vapi really said. Caller holds the
 * session lock. A reply Vapi never spoke is removed. When the request's text extends the last turn run (the user kept
 * talking after a pause), that whole turn is undone so the full text is routed once, on the state before it; with no
 * undo available, only the words not yet recorded are used. '' means nothing new to answer.
 */
function reconcile(s: Session, body: unknown, deps: Deps): { text: string; noFiller: boolean } {
  // A phantom can be classified while this request waits for the lock. Reapply its boundary to the raw body.
  const sanitized = applyPhantomHistoryBoundary(s, body);
  if (sanitized !== body && !requestUserText(s, sanitized)) return { text: '', noFiller: false };
  body = sanitized;
  // Growing utterance: undo the previous attempt only on positive webhook evidence that the caller kept talking
  // before hearing it (speech started after its request, and no model text played in between). No events: skip.
  // Three conditions, all from evidence: the caller's latest speech start came before the first real sentence of the
  // previous attempt could have been heard (emission + 250 ms; needs no playback event), and no model text, assistant
  // speech or interruption was seen in between.
  const rec = lastUndoRecord(s);
  const startedAt = rec ? deps.spoken.lastUserStartAfter(s.id, rec.requestAt) : undefined;
  if (rec && startedAt !== undefined && startedAt < (rec.replyAt ?? Infinity) + HEARD_AFTER_MS && !deps.spoken.modelPlaybackBetween(s.id, rec.requestAt, Date.now())) {
    // A first piece spoken over a reply is placed by Vapi before the cut assistant message: it is part of the text.
    const prev = lastBarge.get(s);
    const barge = prev && prev.text === rec.userText ? prev.barge : '';
    let joined = joinText(barge, utteranceText(messagesOf(body), [...FILLERS, ...sentencesOf(rec.reply), ...undoneSentences(s)])).slice(0, MAX_TEXT);
    // The previous attempt spoke nothing but a filler, so Vapi's text may not repeat it: join its words with the new ones.
    if (rec.reply === '' && !extendsText(joined, rec.userText)) joined = joinText(rec.userText, userTextSinceLastAssistant(body)).slice(0, MAX_TEXT);
    if (words(joined).length > words(rec.userText).length && extendsText(joined, rec.userText)) {
      const undo = undoAndNote(s);
      if (undo) {
        lastBarge.set(s, { text: joined, barge });
        return { text: joined, noFiller: undo.filler };
      }
    }
  }
  let noFiller = false;
  const undoNoted = (): boolean => {
    const undo = undoAndNote(s);
    if (undo?.filler) noFiller = true;
    return undo !== null;
  };
  let status = trimToSpoken(s, body);
  // The caller cut the assistant off: keep only the words the transcripts say were spoken. A reply dropped entirely
  // leaves the path ending in the user turn, which the "no reply recorded" case below then handles.
  // Vapi's own message saying the whole reply was spoken settles it. Barge-in words are read first: the trim can make
  // the stored reply shorter than Vapi's message, which `bargeIn` needs to find it.
  const bargeWords = bargeIn(s, body);
  if (status !== 'spoken') trimLastReplyToSpoken(s, deps, 'interrupt');
  if (status !== 'none' && pathTurns(s, s.currentBranchId).at(-1)?.role !== 'assistant') status = 'none';
  let text = joinText(bargeWords, userTextSinceLastAssistant(body)).slice(0, MAX_TEXT);
  if (!text) return { text, noFiller };
  lastBarge.set(s, { text, barge: bargeWords });
  // Barge-in tail (live call 2): Vapi may append words said over a reply to the previous user message, and insert the cut
  // assistant message only later. If the caller demonstrably heard part of that reply (interruption plus assistant speech
  // in its own window, and the trim above left some of it), the extra words are a new turn, not a longer utterance:
  // keep the recorded turn and its trimmed reply, and route only the new words.
  const prev = lastUndoRecord(s);
  const tail = pathTurns(s, s.currentBranchId).at(-1);
  if (prev && prev.firstEmitAt !== undefined && status !== 'cut' && status !== 'spoken' && tail?.role === 'assistant' && tail.id === prev.lastTurnId && tail.text.trim()
    && words(text).length > words(prev.userText).length && extendsText(text, prev.userText)) {
    const sp = deps.spoken.spokenSince(s.id, prev.firstEmitAt);
    // Model words must show in the transcripts (fillers and superseded text stripped): a cut with no transcript proves nothing.
    const earlierSentences = pathTurns(s, s.currentBranchId).filter((t) => t.role === 'assistant').slice(-3, -1).flatMap((t) => sentencesOf(t.text));
    const heardWords = stripLeadingTokens(tokenize(sp.text).map((x) => x.t), [...FILLERS, ...undoneSentences(s), ...earlierSentences]).length > 0;
    if (sp.interrupted && sp.segments > 0 && !sp.early && heardWords) {
      const rest = wordsAfter(text, words(prev.userText).length);
      lastBarge.set(s, { text: rest, barge: '' });
      return { text: rest, noFiller };
    }
  }
  if (status === 'none') {
    // The path ends in a user turn that got no reply (a silent one records nothing): the user kept talking.
    const last = pathTurns(s, s.currentBranchId).at(-1);
    if (last?.role !== 'user' || last.scratched || !extendsText(text, last.text)) return { text, noFiller };
    if (lastTurnText(s) !== undefined && undoNoted()) return { text, noFiller };
    // No undo point: replace the turn (its branch operation, if any, stays as applied).
    const i = s.turns.lastIndexOf(last);
    if (i >= 0 && last.branchId === s.currentBranchId) {
      s.turns.splice(i, 1);
      s.revision += 1;
    }
    return { text, noFiller };
  }
  if (status !== 'unspoken') return { text, noFiller };
  const prior = lastTurnText(s);
  if (prior !== undefined && extendsText(text, prior)) {
    undoNoted();
    return { text, noFiller };
  }
  // No undo (restored session, or something else changed since). Only when the user plainly kept talking
  // (their text extends the recorded turn) is the reply known to be unheard: drop it and use the new words.
  // Otherwise it may still be being spoken (a request queued behind it): leave everything alone.
  const path = pathTurns(s, s.currentBranchId);
  const trailing = path.at(-2);
  if (trailing?.role !== 'user' || !extendsText(text, trailing.text)) return { text, noFiller };
  const have = words(trailing.text).length;
  // Same speech again: keep the recorded turn and its reply alone.
  if (words(text).length <= have) return { text: '', noFiller };
  text = wordsAfter(text, have);
  const i = s.turns.lastIndexOf(path.at(-1)!);
  if (i >= 0) {
    s.turns.splice(i, 1);
    s.revision += 1;
  }
  return { text, noFiller };
}
/** `text` without its first `have` words (punctuation-only tokens do not count). */
function wordsAfter(text: string, have: number): string {
  let seen = 0;
  const tokens = text.split(/\s+/).filter((w) => words(w).length);
  return tokens.slice(tokens.findIndex((w) => (seen += words(w).length) > have)).join(' ');
}
const words = (t: string): string[] => t.split(/\s+/).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')).filter(Boolean);

/** A streamed turn that is queued or running, so a newer request that extends its text can cut it off at once. */
interface Running { sessionId: string; text: string; abort: () => void; emitted: string[] }

export function mountVapi(app: Express, deps: Deps, lock: Lock): void {
  const running = new Set<Running>();
  app.post('/vapi/chat/completions', async (req: Request, res: Response) => {
    const t0 = performance.now();
    const receivedAt = Date.now();
    if (!deps.vapiSecret) return void res.status(503).json({ error: 'custom LLM secret not configured' });
    if (!secretOk(deps.vapiSecret, req)) return void res.status(401).json({ error: 'unauthorized' });

    const rawBody = req.body ?? {};
    logKeysOnce('llm', rawBody);
    captureMessages(rawBody);
    const callId = typeof rawBody?.call?.id === 'string' ? rawBody.call.id : '';
    // Binding is by explicit call id only. No "latest session" and no transcript similarity.
    const sessionId = callId ? deps.bindings.get(callId) : undefined;
    const state = sessionId ? deps.sessions.get(sessionId) : undefined;
    // Best effort before the lock (is there anything to answer?); the turn re-reads it under the lock.
    const body = state ? applyPhantomHistoryBoundary(state, rawBody, false) : rawBody;
    let userText = state ? requestUserText(state, body) : userTextSinceLastAssistant(body);

    const stream = body.stream === true;
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = 'branch-voice';
    let firstByteMs = 0;
    const epoch = () => (state ? (deps.responseEpoch.get(state.id) ?? 0) : 0);
    const epochAtStart = epoch();

    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const finishJson = (reply: string) => {
      res.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      });
      firstByteMs = Math.round(performance.now() - t0);
    };

    let revision = -1;
    let noFiller = false;
    let stopReason: string | undefined;
    // Held, or nothing new was said since the last spoken reply: answer with silence and record nothing.
    // An ended session is read-only: same silence, and nothing is recorded (not even a trim of the last reply).
    if (!state || state.hold || state.ended || !userText) {
      const reply = !state ? UNBOUND_REPLY : '';
      if (state && !state.ended && (body === rawBody || userText)) {
        await lock(state.id, async () => trimToSpoken(state, body));
        revision = state.revision;
      }
      if (!stream) {
        finishJson(reply);
      } else {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(chunk({ role: 'assistant', content: reply }, null));
        res.write(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        firstByteMs = Math.round(performance.now() - t0);
      }
    } else {
      // Held for the whole request: a phantom resume finishes this very trace (calling current() again after
      // firstChunkAt is set would open a new one).
      const reqTrace = currentTrace(deps, state.id, 'llm');
      reqTrace.llmRequestAt ??= Date.now();
      const finishPhantom = (wrote: boolean) => {
        reqTrace.appliedOp = 'phantom-resume';
        if (wrote) reqTrace.firstEmitAt ??= Date.now();
        reqTrace.firstChunkAt ??= Date.now();
        reqTrace.doneAt = Date.now();
      };
      // Looked up under the session lock, right before the turn, so a prior turn's revision bump is seen.
      const speculated = () => deps.speculator?.lookup(state, userText, currentTrace(deps, state.id, 'llm')) ?? undefined;
      let resumed: string | null = null;
      if (!stream) {
        let r;
        try {
          r = await lock(state.id, async () => {
            if (state.ended) return null; // ended while queued: record nothing, not even a trim
            resumed = await phantomTail(state, rawBody, deps);
            if (resumed !== null) { finishPhantom(!!resumed); return null; } // a phantom tail: nothing recorded, the cut reply resumes
            ({ text: userText, noFiller } = reconcile(state, rawBody, deps));
            if (!userText) return null;
            if (state.hold || state.ended) return null; // held (or ended) while queued behind another turn: stay silent
            const pub = publishDecisions(deps, state.id);
            const out = await runTurn(deps, state, userText, { decision: speculated(), onDecision: pub.onDecision, noFiller });
            stopReason = deps.traces.list(state.id).at(-1)?.modelStopReason;
            markVoiceReply(state);
            pub.settle(out);
            return out;
          });
        } finally {
          deps.speculator?.endUtterance(state.id);
        }
        revision = state.revision;
        finishJson(resumed ?? r?.reply ?? '');
      } else {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        deps.switchedDuring.delete(state.id); // a marker left by an earlier, idle switch must not count
        let ac = new AbortController();
        let baseline = epochAtStart;
        const checkEpoch = () => {
          if (epoch() !== baseline) ac.abort(); // the user interrupted or switched: stop speaking
        };
        const timer = setInterval(checkEpoch, 50);
        let dropped = false;
        res.on('close', () => {
          dropped = true;
          ac.abort(); // Vapi dropped the connection
        });
        // The user kept talking: a turn still queued or streaming for a shorter version of this text is stale.
        // Cut it off now so this request does not wait for it to finish; it leaves no trace (see runTurn's rollback).
        const mine: Running = { sessionId: state.id, text: userText, abort: () => ac.abort(), emitted: [] };
        for (const r of running) {
          if (r.sessionId !== state.id) continue;
          // Also when the new text only extends it once fillers and the sentences it already wrote are set aside.
          // Only while it has spoken nothing but fillers: a heard reply is never cut by the user's next words.
          const onlyFillers = stripLeading(r.emitted.join(' '), FILLERS) === '';
          const pre = onlyFillers ? utteranceText(messagesOf(body), [...FILLERS, ...undoneSentences(state)]) : '';
          if ((words(userText).length > words(r.text).length && extendsText(userText, r.text)) || (words(pre).length > words(r.text).length && extendsText(pre, r.text))) r.abort();
        }
        running.add(mine);
        let first = true;
        const emit = (sentence: string) => {
          mine.emitted.push(sentence);
          res.write(first ? chunk({ role: 'assistant', content: voiceChunk(sentence) }, null) : chunk({ content: ` ${voiceChunk(sentence)}` }, null));
          if (first) {
            first = false;
            firstByteMs = Math.round(performance.now() - t0);
            deps.replyWriting.add(state.id);
          }
        };
        const attempt = (useSpeculation: boolean) => async () => {
          if (state.ended) return null; // ended while queued: record nothing, not even a trim
          if (!useSpeculation) {
            if (!deps.switchedDuring.has(state.id)) return null; // speech landed since the check: Vapi resends, no rebuild
            // The queued switch has been applied by now; only a move after this point aborts the rebuild.
            ac = new AbortController();
            baseline = epoch();
            deps.switchedDuring.delete(state.id);
            if (dropped) ac.abort();
          } else {
            resumed = await phantomTail(state, rawBody, deps);
            if (resumed !== null) {
              // A phantom tail: nothing recorded; say the rest of the cut reply.
              for (const sentence of sentencesOf(resumed)) {
                checkEpoch();
                if (ac.signal.aborted) break;
                emit(sentence);
                reqTrace.firstEmitAt ??= Date.now();
              }
              finishPhantom(false);
              return null;
            }
            ({ text: userText, noFiller } = reconcile(state, rawBody, deps));
            if (!userText) return null;
          }
          if (state.hold || state.ended) return null; // held (or ended) while queued behind another turn: stay silent
          checkEpoch();
          if (ac.signal.aborted) return null; // interrupted or dropped before the turn began: leave the session alone
          const signal = ac.signal;
          const pub = publishDecisions(deps, state.id);
          const out = await runTurn(deps, state, userText, {
            signal,
            onDecision: pub.onDecision,
            decision: useSpeculation ? speculated() : undefined,
            noFiller,
            onSentence: (sentence) => {
              checkEpoch();
              if (signal.aborted) return;
              emit(sentence);
            },
          });
          stopReason = deps.traces.list(state.id).at(-1)?.modelStopReason;
          markVoiceReply(state);
          pub.settle(out);
          return out;
        };
        try {
          let r = await lock(state.id, attempt(true));
          // Stale guard: a tap-switch (not speech) cut the reply before anything was said, so the turn was rolled back.
          // Rebuild once for the branch now current; the switch queued on the lock runs before this second acquisition.
          if (first && ac.signal.aborted && !dropped && deps.switchedDuring.has(state.id)) {
            r = await lock(state.id, attempt(false));
          }
          revision = state.revision;
          if (first && !res.writableEnded) res.write(chunk({ role: 'assistant', content: '' }, null)); // silent reply still opens the message
        } catch {
          // Never leave Vapi hanging: fall through to the closing frames. Log ids only.
          console.log(JSON.stringify({ sessionId: state.id, error: 'turn-failed' }));
        } finally {
          running.delete(mine);
          deps.replyWriting.delete(state.id);
          deps.switchedDuring.delete(state.id);
          clearInterval(timer);
          deps.speculator?.endUtterance(state.id);
        }
        if (!res.writableEnded) {
          res.write(chunk({}, 'stop'));
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    }
    // One trace line per request; deliberately no transcript text.
    console.log(JSON.stringify({ requestId: id, receivedAt, sessionId: state?.id ?? null, callId: callId || null, revision, msReceivedToFirstByte: firstByteMs, ...(stopReason ? { stopReason } : {}) }));
  });
}
