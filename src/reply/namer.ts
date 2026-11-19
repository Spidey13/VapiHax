import Anthropic from '@anthropic-ai/sdk';

/** Longest branch name: longer ones were cut off in the branch map ("Saturday afternoo…"). */
export const NAME_MAX = 24;

/** At most four words (a "+" counts as one) and `NAME_MAX` characters, dropping whole words from the end. */
export function cleanName(raw: string): string | null {
  const words = raw
    .replace(/[^\p{L}\p{N}\s'+-]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  while (words.length > 1 && words.join(' ').length > NAME_MAX) words.pop();
  while (words.length && !/[\p{L}\p{N}]/u.test(words.at(-1)!)) words.pop(); // never end on a bare "+"
  const name = words.join(' ');
  return /[\p{L}\p{N}]/u.test(name) ? name : null;
}

/** The text the namer gets for a merged branch, so the name says what was combined. */
export const mergeNamePrompt = (a: string, b: string): string => `Combine "${a}" with "${b}".`;

export interface Namer {
  name(utterance: string): Promise<string | null>;
}

const NAMER_SYSTEM = [
  'Name the idea the speaker is exploring as a short noun phrase of one to three plain words, under 20 characters, using their own words where possible, such as "Backyard barbecue" or "Restaurant dinner".',
  'Leave out filler words such as instead, idea, plan or option.',
  'When asked to combine two ideas, name the combination as one word for each joined by a plus sign, such as "Restaurant + barbecue".',
  'Reply with the name only.',
].join(' ');

export class ClaudeNamer implements Namer {
  private client: Anthropic;
  private model: string;

  constructor(opts: { client?: Anthropic; model?: string } = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? (process.env.BACKGROUND_MODEL || 'claude-opus-5-5');
  }

  async name(utterance: string): Promise<string | null> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        // 256, not 20: the model always thinks and thinking tokens count against max_tokens.
        max_tokens: 256,
        output_config: { effort: 'low' },
        system: NAMER_SYSTEM,
        messages: [{ role: 'user', content: utterance }],
      });
      const block = res.content.find((b) => b.type === 'text');
      return block && block.type === 'text' ? cleanName(block.text) : null;
    } catch {
      return null;
    }
  }
}
