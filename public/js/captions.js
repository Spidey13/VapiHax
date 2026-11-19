/**
 * Display-only transcript lines, and how much of the assistant's recorded reply to show.
 * State:
 *   finals   user segments the server has not recorded: [{ role, text, base }]. `base` lists the ids of that
 *            role's turns the server path had when the final arrived; a final is dropped once the path holds a
 *            turn of its role outside that list (the server recorded a newer one).
 *   live     the user's current partial: { role, text } | null
 *   said     what the assistant has spoken so far (its transcript events): { text (finals), part (partial) }
 *   closed   the user cut in: assistant captions are dropped until it starts speaking again
 *   speaking true between the assistant's speech-update started and stopped
 *   ended    the assistant's speech stopped (until it starts again). A stop alone reveals nothing more: the reply
 *            stays as far as it was heard, and a late final may still extend it. Only a natural end (the user
 *            speaks well after the stop) freezes it at what the last playback event covered.
 *   playback the assistant.speechStarted events: { turn, text (cumulative for that turn), played }. `played` is the
 *            text of the previous event of the turn: Vapi sends one per TTS chunk when it starts playing, so an
 *            event proves the chunks before it were played, not the current one. Not a word cursor.
 *   stoppedAt when it stopped (ms, if the caller gave a clock)
 *   turnAt   when the reply under way began to be spoken (ms, the caller's clock; 0 = unknown). Playback events
 *            carry the whole reply at once, so with a clock the caption is paced at TTS_WORDS_PER_SEC from here.
 *   claimed  the playback turn already took turnAt (a later new turn starts its own)
 *   prov     { id, turn } | null: the cut of reply `id` came from an unconfirmed user partial alone (a phantom), at
 *            playback turn `turn`. If the same reply resumes (a later playback turn continuing it), the cut is
 *            reopened; a real floor-taking (user speech started, a user final) makes it permanent.
 *   gate     a voice call is live: a fresh reply is shown only as far as it has been spoken
 *   open     show replies at once (a typed turn, which is not spoken)
 *   seen     ids of turns that were on screen before the call began speaking them (never gated)
 *   cut      id -> the part of an interrupted reply that was heard (the final text of that turn on screen)
 *   greeting what the assistant said before any turn
 */
/** @returns {any} */
export const emptyCaptions = () => ({
  finals: [], live: null, said: { text: '', part: '' }, speaking: false, ended: false, stoppedAt: 0, prov: null, now: 0, turnAt: 0, claimed: false, closed: false, gate: false, open: false, seen: {}, cut: {}, greeting: '',
  playback: { turn: -1, text: '', played: '' },
});

const roleIds = (path, role) => path.filter((t) => t.role === role).map((t) => t.id);
const saidAll = (st) => `${st.said.text} ${st.said.part}`.trim();
const join = (a, b) => (a && b ? `${a} ${b}` : a || b);
const FLUSH = /<\s*flush\s*\/?>|<\s*\/\s*flush\s*>/gi; // Vapi's TTS flush markers, never display text
const stripFlush = (s) => String(s).replace(FLUSH, ' ').replace(/\s+/g, ' ').trim();
/** The reply under way: the path ends in it (the server records it before it is spoken). */
const targetOf = (path) => (path.at(-1)?.role === 'assistant' ? path.at(-1) : null);
const retireStaleProv = (st, path) => st.prov && targetOf(path)?.id !== st.prov.id ? { ...st, prov: null } : st;
export const syncCaptionPath = (st, path) => retireStaleProv(st, path);

const WORD = /[\p{L}\p{N}]+/gu;
const words = (s) => [...s.toLowerCase().matchAll(WORD)].map((m) => ({ w: m[0], at: m.index, end: m.index + m[0].length }));
const norm = (s) => ` ${words(s).map((x) => x.w).join(" ")} `;

/** How many recorded words the spoken words match, in order. A few misheard or reworded words are skipped. */
function matched(rec, spoken, maxLead = Infinity) {
  let p = 0;
  spoken.forEach((s, j) => {
    if (p === 0 && j > maxLead) return; // a spoken filler is never recorded, but only a few words of it
    for (let i = p; i < Math.min(rec.length, p + 4); i++) if (rec[i].w === s.w) { p = i + 1; break; }
  });
  return p;
}
/** The recorded text through word `p`, with the punctuation attached to it. */
const throughWord = (recorded, rec, p) => {
  const end = rec[p - 1].end;
  return recorded.slice(0, end + /^[^\s\p{L}\p{N}]*/u.exec(recorded.slice(end))[0].length).trim();
};

/**
 * How much of `recorded` the assistant has spoken: spoken words are matched in order against the recorded
 * words, then the text is cut at the last whole sentence whose words were all matched while speech goes on,
 * and at the last matched word (with its punctuation) once it has stopped. Never rounds forward.
 */
export function revealedText(recorded, said, speaking) {
  const rec = words(recorded);
  if (!rec.length) return recorded;
  const p = matched(rec, words(said));
  if (p === 0) return '';
  if (!speaking) return throughWord(recorded, rec, p);
  let end = p === rec.length ? recorded.length : 0;
  for (const hit of recorded.matchAll(/[.!?]+["')\]]*(?=\s|$)/g)) {
    const e = hit.index + hit[0].length;
    if (rec.filter((x) => x.at < e).length <= p) end = e;
  }
  return recorded.slice(0, end).trim();
}

/** What the playback events prove was played: `played` matched from the reply's first word (a filler may lead it). */
function playedCoverage(recorded, played) {
  const rec = words(recorded);
  const p = rec.length ? matched(rec, words(played), 4) : 0;
  return p ? throughWord(recorded, rec, p) : '';
}
const longer = (a, b) => (b.length > a.length ? b : a);
/** How fast the voice speaks (words per second): Deepgram aura-2 thalia, ~32 words in ~12 s. */
export const TTS_WORDS_PER_SEC = 2.7;
/**
 * What playback proves was played, paced by time. With a clock the whole text of the playback events is the proof
 * (Vapi sends the full short reply at once) and the cursor at TTS_WORDS_PER_SEC from the turn's start limits it;
 * the cursor stops at the stop of speech. Without a clock: the text before the current chunk.
 */
function pacedCoverage(st, recorded, speaking, now) {
  if (!st.turnAt || !now) return playedCoverage(recorded, st.playback.played);
  const rec = words(recorded);
  const spoken = words(st.playback.text);
  const p = rec.length ? matched(rec, spoken, 4) : 0;
  const upTo = speaking || !st.stoppedAt ? now : Math.min(now, st.stoppedAt);
  // A leading filler ("Okay, let me see.") is spoken first: its words use up the time before the reply starts.
  const lead = Math.max(0, spoken.findIndex((x, j) => j <= 4 && rec.slice(0, 4).some((r) => r.w === x.w)));
  const k = Math.min(p, Math.max(0, Math.floor(((upTo - st.turnAt) / 1000) * TTS_WORDS_PER_SEC) - lead));
  return k ? throughWord(recorded, rec, k) : '';
}
/** The reply under way as far as it is honestly known to be heard: transcript reveal or playback, whichever reaches further. */
const heard = (st, text, speaking = st.speaking, now = st.now) => longer(revealedText(text, saidAll(st), speaking), pacedCoverage(st, text, speaking, now));

/**
 * Where in `turn`'s recorded words a provisionally cut reply resumed: the playback turn is newer than the cut and
 * its first words follow the heard prefix. -1 if it did not resume.
 */
function resumeOffset(st, turn) {
  const pv = st.prov;
  if (!pv || pv.id !== turn.id || st.playback.turn <= pv.turn || !st.playback.text || !(turn.id in st.cut)) return -1;
  const rec = words(turn.text);
  const pb = words(st.playback.text);
  const cutLength = words(st.cut[turn.id]).length;
  const candidates = [];
  for (let o = 0; o < rec.length; o++) {
    let length = 0;
    while (o + length < rec.length && length < pb.length && rec[o + length].w === pb[length].w) length++;
    const overlaps = o < cutLength;
    if (length >= (overlaps ? 3 : 2) && (!overlaps || o + length > cutLength)) candidates.push({ offset: o, length });
  }
  if (!candidates.length) return -1;
  const strongest = Math.max(...candidates.map((c) => c.length));
  const best = candidates.filter((c) => c.length === strongest);
  return best.length === 1 ? best[0].offset : -1;
}
/** A resumed reply as heard: the cut prefix, the words between, then the resumed suffix as it is spoken. */
function heardResumed(st, turn, o, speaking, now, natural = false) {
  const rec = words(turn.text);
  const sub = turn.text.slice(rec[o].at);
  let h = heard(st, sub, speaking, now);
  if (natural) h = longer(h, playedCoverage(sub, st.playback.text));
  const overlap = Math.max(0, words(st.cut[turn.id]).length - o);
  if (overlap) {
    if (words(h).length <= overlap) return st.cut[turn.id];
    const resumed = throughWord(turn.text, rec, o + words(h).length);
    return resumed.length > st.cut[turn.id].length ? resumed : st.cut[turn.id];
  }
  return h ? `${turn.text.slice(0, rec[o].at)}${h}`.trim() : st.cut[turn.id];
}

/** A playback event (Vapi assistant.speechStarted): track the turn and the text before the current chunk. */
export function playbackEvent(st, ev, now = 0) {
  if (!ev || typeof ev.turn !== 'number' || typeof ev.text !== 'string') return st;
  const text = stripFlush(ev.text);
  const pb = st.playback;
  if (ev.turn < pb.turn) return st; // stale
  // A new turn: the earlier reply's spoken words must not count for it (nothing earlier on the first event).
  if (ev.turn > pb.turn) {
    // The turn's start: the speech-update that began it, else this first event.
    const own = !st.turnAt || st.claimed;
    return { ...st, said: pb.turn < 0 ? st.said : { text: '', part: '' }, playback: { turn: ev.turn, text, played: '' }, turnAt: own ? now : st.turnAt, claimed: true, now: now || st.now };
  }
  if (text === pb.text) return st; // duplicate
  const [a, b] = [words(pb.text), words(text)];
  const grows = b.length > a.length && a.every((x, i) => x.w === b[i].w);
  return grows ? { ...st, playback: { turn: ev.turn, text, played: pb.text }, now: now || st.now } : st;
}

const gated = (st, t) => st.gate && !st.open && !st.seen[t.id] && !(t.id in st.cut);

/** The server path with the reply under way cut to what has been spoken, and interrupted replies as heard. */
export function revealPath(st, path, now = st.now) {
  const t = targetOf(path);
  return path.flatMap((turn) => {
    if (turn.role !== 'assistant') return [turn];
    let text = turn.text;
    if (turn.id in st.cut) { const o = turn === t ? resumeOffset(st, turn) : -1; text = o < 0 ? st.cut[turn.id] : heardResumed(st, turn, o, st.speaking, now); }
    else if (gated(st, turn)) text = turn === t ? heard(st, turn.text, st.speaking, now) : ''; // an older unspoken reply stays unheard
    if (text === turn.text) return [turn];
    return text ? [{ ...turn, text }] : [];
  });
}

/** The user took the floor (or the reply ended): freeze what was heard and forget the spoken words. */
export function settle(st, path, force = false, natural = false, now = st.now, provisional = false) {
  const spoken = saidAll(st);
  if (!spoken && !st.playback.played && !force) return st;
  const t = targetOf(path);
  let { cut, greeting, prov } = st;
  if (t) {
    const o = resumeOffset(st, t);
    if (o >= 0) cut = { ...cut, [t.id]: heardResumed(st, t, o, false, now, natural && st.ended) };
    if (gated(st, t) || o >= 0) prov = provisional ? { id: t.id, turn: st.playback.turn } : null;
    if (gated(st, t)) {
      // Natural completion (the user spoke well after the stop): the last playback event's text was all playing.
      const h = heard(st, t.text, false, now);
      cut = { ...cut, [t.id]: natural && st.ended ? longer(h, playedCoverage(t.text, st.playback.text)) : h };
    }
  } else if (!path.length && !greeting) greeting = spoken;
  // The turn id stays (to ignore stale events); its words do not carry into the next reply.
  const playback = { ...st.playback, text: '', played: '' };
  return { ...st, cut, prov, greeting, playback, turnAt: 0, claimed: false, said: { text: '', part: '' }, open: false, speaking: false, ended: false, closed: true };
}

/** The user started speaking, the assistant started or stopped: speech-update events. */
export const CUT_IN_MS = 1500;
export function speechEvent(st, role, status, path, now = 0) {
  if (role === 'assistant') {
    st = retireStaleProv(st, path);
    const started = status === 'started';
    return {
      ...st, speaking: started, ended: started ? false : !!saidAll(st) && !st.closed, stoppedAt: started ? st.stoppedAt : now,
      turnAt: started ? now : st.turnAt, claimed: started ? false : st.claimed, now: now || st.now,
      closed: started ? false : st.closed, open: started ? false : st.open,
    };
  }
  if (status !== 'started') return st;
  // The user spoke well after the reply had ended on its own: nothing was cut in on, so the reply stays whole.
  const natural = st.ended && !st.speaking && now > 0 && st.stoppedAt > 0 && now - st.stoppedAt > CUT_IN_MS;
  return { ...settle({ ...st, now: now || st.now }, path, true, natural, now || st.now), prov: null, live: st.live?.role === 'user' ? st.live : null };
}

/**
 * A final transcript segment. User segments are kept until the server records a user turn. Assistant
 * segments accumulate in `said` (the reply itself arrives through the server path).
 */
export function addFinal(st, role, text, path) {
  st = retireStaleProv(st, path);
  if (role !== 'user') return st.closed ? st : { ...st, said: { text: join(st.said.text, stripFlush(text)), part: '' } };
  const s = st.speaking ? st : settle(st, path);
  return { ...s, prov: null, finals: [...s.finals, { role, text, base: roleIds(path, role) }], live: null };
}

/** A partial transcript: the user's overwrites the trailing live row; the assistant's replaces its spoken tail. */
export function setPartial(st, role, text, path = []) {
  st = retireStaleProv(st, path);
  if (role === 'assistant') return st.closed ? st : { ...st, said: { text: st.said.text, part: stripFlush(text) } };
  const s = st.speaking ? st : settle(st, path, false, false, st.now, true); // a partial alone may be a phantom
  return { ...s, live: { role, text } };
}

/** A typed turn in flight shows as a live row, nothing else. */
export const clearLive = (st) => ({ ...st, live: null });

/**
 * A voice call went live or ended. Ending freezes every gated reply on `path` as far as it was heard (an older
 * unspoken one at nothing) so a disconnect never exposes unheard text; typed turns and the greeting are not gated.
 */
export function setGate(st, gate, path = [], now = st.now) {
  st = retireStaleProv(st, path);
  if (gate) return { ...st, gate };
  const t = targetOf(path);
  const cut = { ...st.cut };
  for (const turn of path) {
    if (turn.role !== 'assistant') continue;
    const o = turn === t ? resumeOffset(st, turn) : -1;
    if (o >= 0) cut[turn.id] = heardResumed(st, turn, o, false, now);
    else if (gated(st, turn)) cut[turn.id] = turn === t ? heard(st, turn.text, false, now) : '';
  }
  return { ...st, gate, cut, prov: null, speaking: false };
}

/** Replies appear at once (typed turns are not spoken). */
export const openReplies = (st) => ({ ...st, open: true });

/** Everything on this path was on screen before the call spoke it: never gate it. */
export function markSeen(st, path) {
  const seen = { ...st.seen };
  for (const t of path) seen[t.id] = true;
  return { ...st, seen };
}

/** Drop finals the server path has caught up with. */
export function prune(st, path) {
  const finals = st.finals.filter((f) => roleIds(path, f.role).every((id) => f.base.includes(id)));
  return finals.length === st.finals.length ? st : { ...st, finals };
}

/** The greeting, spoken before any turn, leads the transcript. */
export function greetingRows(st, path) {
  return st.greeting && (!path.length || path[0].role === 'user') ? [{ role: 'assistant', text: st.greeting, live: false }] : [];
}

/**
 * Rows to append after the server path: the user's current turn as one row (surviving finals plus the live
 * partial), then, if the reply under way is not recorded yet, what the assistant has said so far.
 */
export function captionRows(st, path) {
  const rows = [];
  // A segment the recorded user turn already holds (a late partial or final) is not shown again.
  const last = norm(path.findLast((t) => t.role === 'user')?.text ?? '');
  const fresh = (t) => !last.includes(norm(t));
  const mine = prune(st, path).finals.map((f) => f.text).filter(fresh);
  const partial = st.live?.role === 'user' && fresh(st.live.text) ? st.live.text : '';
  const text = [...mine, partial].filter(Boolean).join(' ');
  if (text) rows.push({ role: 'user', text, live: !!partial });
  // Once speech has stopped, a trailing partial word is not shown: it may be a fragment ("Fur" of "Furano").
  const part = st.ended && st.said.part && !/[.!?,;:]["')\]]*$/.test(st.said.part) ? st.said.part.replace(/\s*\S*$/, '') : st.said.part;
  const spoken = `${st.said.text} ${part}`.trim();
  if (spoken && !targetOf(path)) rows.push({ role: 'assistant', text: spoken, live: !!part });
  return rows;
}

/**
 * While a structural transition waits in the queue: the old sheet's path plus the turns of the
 * incoming sheet's path that the old one lacks (the forking user turn and the reply), no structure change.
 */
export function pendingPath(shownPath, nextPath) {
  const have = new Set(shownPath.map((t) => t.id));
  return [...shownPath, ...nextPath.filter((t) => !have.has(t.id))];
}

/**
 * The rows on screen: greeting, the visible server turns, then live captions. The user's current speech joins the
 * last row only when that row is the recorded user turn at the end of the path (a continuation of it): it then
 * replaces that row if it restates it, else follows it. Recorded turns are never merged with each other.
 * @returns {{ role: string, text: string, corrected: boolean, live: boolean }[]}
 */
export function transcriptRows(st, path, now = st.now) {
  const lead = greetingRows(st, path).map((c) => ({ ...c, corrected: false }));
  const rows = [...lead, ...revealPath(st, path, now).map((t) => ({ role: t.role, text: t.text, corrected: t.kind === 'correction', live: false }))];
  const last = rows.at(-1);
  // The path must itself end in that user turn: a hidden (unheard) reply after it means a new utterance.
  const recorded = rows.length > lead.length && last.role === 'user' && path.at(-1)?.role === 'user';
  captionRows(st, path).forEach((c, i) => {
    if (i === 0 && c.role === 'user' && recorded) {
      last.text = norm(c.text).startsWith(norm(last.text)) ? c.text : `${last.text} ${c.text}`;
      last.live = c.live;
    } else rows.push({ ...c, corrected: false });
  });
  return rows;
}
