import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Content may be a string or an OpenAI-style array of parts; parse defensively. */
export function contentText(c: unknown): string {
  if (typeof c === 'string') return stripFlush(c);
  if (Array.isArray(c)) {
    return stripFlush(
      c
        .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
        .join(' '),
    );
  }
  return '';
}

/** Vapi's voice-control tag (`<flush />`, `<flush>`, `</flush>`), which we add to outgoing frames; never part of what was said. */
const FLUSH_TAG = /<\s*flush\s*\/?\s*>|<\s*\/\s*flush\s*>/gi;
const stripFlush = (t: string): string => t.replace(FLUSH_TAG, '');

/** A word reduced to lower-case letters and digits. */
const key = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const words = (t: string): string[] => t.split(/\s+/).map(key).filter(Boolean);

/** True when `full` starts with `prior`, word by word, ignoring case and punctuation. Equal text counts. */
export function extendsText(full: string, prior: string): boolean {
  const p = words(prior);
  const f = words(full);
  if (!p.length || f.length < p.length) return false;
  return p.every((w, i) => f[i] === w);
}

interface Tok { t: string; end: number }

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const APOSTROPHES = new Set(["'", '’', '‘', 'ʼ', '`']);
const isWordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}]/u.test(c);

/** Tokens of `text` with the end offset (in `text`) of each: folded, with numbers 0-99 and "half" made canonical. */
export function tokenize(text: string): Tok[] {
  // Per-character NFKC + lower-case, each output char remembering where its source character ends.
  const chars: { c: string; end: number }[] = [];
  let at = 0;
  for (const cp of text) {
    at += cp.length;
    for (const c of cp.normalize('NFKC').toLowerCase()) chars.push({ c, end: at });
  }
  const raw: Tok[] = [];
  let cur = '';
  let curEnd = 0;
  const flush = () => {
    if (cur) raw.push({ t: cur, end: curEnd });
    cur = '';
  };
  for (let i = 0; i < chars.length; i++) {
    const { c, end } = chars[i]!;
    const prev = chars[i - 1]?.c;
    const next = chars[i + 1]?.c;
    if (isWordChar(c)) {
      cur += c;
      curEnd = end;
    } else if (cur && APOSTROPHES.has(c) && isWordChar(prev) && isWordChar(next)) {
      // inside a word: dropped, the word carries on
    } else if (cur && c === '.' && /^\d+$/.test(cur) && /\p{N}/u.test(next ?? '') && /\p{N}/u.test(prev ?? '')) {
      cur += c; // decimal point inside a number
    } else flush();
  }
  flush();
  const out: Tok[] = [];
  for (let i = 0; i < raw.length; i++) {
    const { t, end } = raw[i]!;
    const nextOne = raw[i + 1] && ONES[raw[i + 1]!.t] !== undefined && ONES[raw[i + 1]!.t]! >= 1 && ONES[raw[i + 1]!.t]! <= 9 ? ONES[raw[i + 1]!.t]! : undefined;
    if (TENS[t] !== undefined) {
      if (nextOne !== undefined) {
        out.push({ t: String(TENS[t]! + nextOne), end: raw[i + 1]!.end });
        i++;
      } else out.push({ t: String(TENS[t]!), end });
    } else if (ONES[t] !== undefined) out.push({ t: String(ONES[t]), end });
    else if (t === 'half') out.push({ t: '0.5', end });
    else out.push({ t, end });
  }
  return out;
}

/**
 * Whether Vapi's spoken text is the start of the recorded reply once case, punctuation, apostrophes and numbers
 * (0-99, "half") are normalized. Every spoken word must equal the recorded word in order from the start. Returns the
 * recorded text up to the last matched word (all of it when `complete`), or null when it does not match.
 */
export function spokenPrefix(recorded: string, spoken: string): { text: string; complete: boolean } | null {
  const s = tokenize(spoken);
  const r = tokenize(recorded);
  if (!s.length || s.length > r.length || s.some((tok, i) => tok.t !== r[i]!.t)) return null;
  if (s.length === r.length) return { text: recorded.trim(), complete: true };
  return { text: recorded.slice(0, r[s.length - 1]!.end).trim(), complete: false };
}

/** How many words `text` has, counted the way `spokenPrefix` and `cutAfterWords` count them. */
export function wordCount(text: string): number {
  return tokenize(text).length;
}

/** `text` up to the end of its first `n` words ('' for none, all of it when it has no more). */
export function cutAfterWords(text: string, n: number): string {
  const r = tokenize(text);
  if (n <= 0) return '';
  if (n >= r.length) return text.trim();
  return text.slice(0, r[n - 1]!.end).trim();
}

interface RawMsg { role?: unknown; content?: unknown }

/**
 * The user words Vapi places before an interrupted assistant message: the user messages just before the last
 * non-empty assistant message, minus the text already recorded as the user turn (`priorUser`). Empty when the
 * block does not start with the recorded text, so nothing unrelated is pulled in.
 */
export function bargeInText(msgs: RawMsg[], priorUser: string): string {
  let i = msgs.length - 1;
  while (i >= 0 && !(msgs[i]?.role === 'assistant' && contentText(msgs[i]!.content).trim())) i--;
  if (i < 0) return '';
  const block: string[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const m = msgs[j];
    if (!m) continue;
    const text = contentText(m.content).trim();
    if (m.role === 'assistant') {
      if (text) break;
      continue;
    }
    if (m.role === 'user' && text) block.unshift(text);
  }
  const tokens = block.join(' ').split(/\s+/).filter(Boolean);
  const prior = priorUser.split(/\s+/).map(key).filter(Boolean);
  if (!prior.length) return '';
  // Walk the tokens, matching the recorded words in order; punctuation-only tokens are skipped.
  let k = 0;
  let t = 0;
  while (t < tokens.length && k < prior.length) {
    const w = key(tokens[t]!);
    if (w) {
      if (w !== prior[k]) return '';
      k++;
    }
    t++;
  }
  if (k < prior.length) return '';
  return tokens.slice(t).join(' ');
}

/**
 * Repeatedly removes any `known` entry from the start of `text` (case-insensitive, whitespace-normalized, "..." equals
 * the ellipsis character, and the entry must end at a word boundary). Returns the trimmed rest.
 */
export function stripLeading(text: string, known: readonly string[]): string {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  let rest = norm(text);
  const forms = known.flatMap((k) => {
    const base = norm(k);
    return base ? [base, base.replace(/…/g, '...')] : [];
  });
  for (let again = true; again && rest; ) {
    again = false;
    const lower = rest.toLowerCase();
    for (const form of forms) {
      if (!lower.startsWith(form.toLowerCase())) continue;
      const next = rest[form.length];
      if (next !== undefined && next !== ' ' && /\w/.test(form[form.length - 1]!)) continue; // mid-word
      rest = rest.slice(form.length).trim();
      again = true;
      break;
    }
  }
  return rest;
}

/**
 * The user words since the last assistant message that spoke something real, joined by single spaces. Like
 * "all user messages after the last non-empty assistant message", except that an assistant message made only of
 * `skippable` text (fillers, replies already undone) is passed over instead of ending the walk.
 */
export function utteranceText(msgs: RawMsg[], skippable: readonly string[]): string {
  const parts: string[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    const text = contentText(m.content).trim();
    if (m.role === 'assistant' && text) {
      if (stripLeading(text, skippable) === '') continue;
      break;
    }
    if (m.role === 'user' && text) parts.unshift(text);
  }
  return parts.join(' ');
}

let captureSeq = 0;

/**
 * Opt-in (env VAPI_CAPTURE_DIR): writes one file per request with the messages only (role, content, and any
 * scalar timing fields), never headers or the call object. System content is replaced by its length.
 * Never throws.
 */
export function captureMessages(body: unknown): void {
  const dir = process.env.VAPI_CAPTURE_DIR;
  if (!dir) return;
  try {
    const raw = (body as { messages?: unknown } | null)?.messages;
    const messages = Array.isArray(raw)
      ? raw.map((m) => {
          if (!m || typeof m !== 'object') return m;
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
            if (k === 'content') out.content = (m as RawMsg).role === 'system' ? `[system ${contentText(v).length} chars]` : v;
            else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
          }
          return out;
        })
      : null;
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${String(++captureSeq).padStart(4, '0')}.json`;
    writeFileSync(join(dir, name), JSON.stringify({ at: new Date().toISOString(), messages }, null, 2));
  } catch {
    /* capture is a debugging aid: never affect the call */
  }
}
