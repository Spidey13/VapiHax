import Anthropic from '@anthropic-ai/sdk';
import type { Turn } from '../tree/types.js';

export interface Digester {
  /** `notes` are digests inherited from combined threads; older fakes may ignore them. */
  digest(name: string, turns: Turn[], signal?: AbortSignal, notes?: string[]): Promise<string>;
}

const DIGEST_WORDS = 150;
const FALLBACK_WITH_NOTES_WORDS = 300;
/** The model is asked for well under the hard cap, so the cap (which ends on a sentence) rarely bites. */
const DIGEST_ASK_WORDS = 80;
const DIGEST_SYSTEM =
  `Condense this thread of a spoken brainstorm into at most ${DIGEST_ASK_WORDS} words of plain prose: what the user wants, what they decided, the reasons they gave, and what is open. ` +
  'Treat a later correction as replacing only the detail it changes, and keep the earlier details it did not replace. ' +
  'Say who proposed what: an idea only the assistant raised is a suggestion, not a decision, unless the user agreed to it. ' +
  'Describe only this thread; do not comment on what is missing from it.';

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const cutWords = (text: string, n: number): string => words(text).slice(0, n).join(' ');

/** At most `n` words, ending on the last complete sentence when one ends in the second half; otherwise words + "…". */
export function cutAtSentence(text: string, n: number): string {
  const w = words(text);
  if (w.length <= n) return w.join(' ');
  const head = w.slice(0, n).join(' ');
  const end = Math.max(...['.', '!', '?'].map((c) => head.lastIndexOf(c)));
  if (end >= 0 && words(head.slice(0, end + 1)).length >= n / 2) return head.slice(0, end + 1);
  return `${head}…`;
}

/**
 * Used when the model call fails: the thread's name and what the user said, chronologically (corrections kept).
 * Over 150 words it keeps the latest correction (or latest user turn) and fills the rest from the earliest user
 * turns, where constraints usually are. Inherited `notes` follow as "Earlier: ..." (whole string capped at 300 words).
 */
export function fallbackDigest(name: string, turns: Turn[], notes?: string[]): string {
  const users = turns.filter((t) => t.role === 'user' && !t.scratched && t.text.trim() !== '');
  let body: string;
  if (!users.length) body = `${name}: nothing said yet.`;
  else {
    const total = users.reduce((n, t) => n + words(t.text).length, 0);
    let chosen = users;
    if (total > DIGEST_WORDS) {
      const keep = [...users].reverse().find((t) => t.kind === 'correction') ?? users[users.length - 1];
      let budget = DIGEST_WORDS - words(keep.text).length;
      const picked = new Set<Turn>([keep]);
      for (const t of users) {
        if (t === keep) continue;
        const n = words(t.text).length;
        if (n > budget) break;
        picked.add(t);
        budget -= n;
      }
      chosen = users.filter((t) => picked.has(t));
    }
    body = cutWords(`${name}: ${chosen.map((t) => t.text.trim()).join(' ')}`, DIGEST_WORDS);
  }
  if (!notes?.length) return body;
  return cutWords(`${body} Earlier: ${notes.join(' ')}`, FALLBACK_WITH_NOTES_WORDS);
}

export class ClaudeDigester implements Digester {
  private client: Anthropic;
  private model: string;

  constructor(opts: { client?: Anthropic; model?: string } = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? (process.env.BACKGROUND_MODEL || 'claude-opus-5-5');
  }

  /** Throws on a failed call or an empty result so the caller can fall back. */
  async digest(name: string, turns: Turn[], signal?: AbortSignal, notes?: string[]): Promise<string> {
    const transcript = turns
      .filter((t) => !t.scratched && t.text.trim() !== '')
      .map((t) => `${t.role === 'user' ? (t.kind === 'correction' ? 'User (correction)' : 'User') : 'Assistant'}: ${t.text}`)
      .join('\n');
    const carried = notes?.length ? `\nContext carried from combined threads:\n${notes.join('\n')}` : '';
    const res = await this.client.messages.create(
      {
        model: this.model,
        // 1024, not 300: the model always thinks and thinking tokens count against max_tokens.
        max_tokens: 1024,
        output_config: { effort: 'low' },
        system: DIGEST_SYSTEM,
        messages: [{ role: 'user', content: `Thread "${name}":\n${transcript}${carried}` }],
      },
      { signal },
    );
    const block = res.content.find((b) => b.type === 'text');
    const text = block && block.type === 'text' ? cutAtSentence(block.text.trim(), DIGEST_WORDS) : '';
    if (!text) throw new Error('empty digest');
    return text;
  }
}
