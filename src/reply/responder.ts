import Anthropic from '@anthropic-ai/sdk';
import type { BranchContext } from '../tree/context.js';
import { SYSTEM_PROMPT } from './prompts.js';

export interface ReplyRequest {
  context: BranchContext;
  instruction?: string;
  /** Called with the model's stop reason once the stream reports it (`'unknown'` when it ended without one). */
  onStop?: (reason: string, usage?: ReplyUsage) => void;
}

/** The model's stream ended without finishing its reply (`max_tokens`, `model_context_window_exceeded`, `refusal`, ...). */
export class ReplyTruncatedError extends Error {
  constructor(public readonly stopReason: string) {
    super(`reply did not finish: ${stopReason}`);
    this.name = 'ReplyTruncatedError';
  }
}

/** Diagnostics for one reply: token counts from the stream and wall-clock times (Date.now) of its first events. */
export interface ReplyUsage {
  outputTokens?: number;
  /** Output tokens spent on thinking (`usage.output_tokens_details.thinking_tokens`), when the stream reports it. */
  thinkingTokens?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** The refusal category (`stop_details.category`) when the model declined, else null/undefined. */
  stopCategory?: string | null;
  /** `message_start` arrived. */
  firstEventAt?: number;
  /** The first thinking block started. */
  thinkingStartAt?: number;
  /** The first text delta arrived. */
  firstTextAt?: number;
}

const CLEAN_STOPS = new Set(['end_turn', 'stop_sequence']);

export interface Responder {
  reply(req: ReplyRequest, signal?: AbortSignal): AsyncIterable<string>;
}

export function replyParams(req: ReplyRequest, model: string) {
  // Notes and the per-reply instruction ride in a second top-level system block: a mid-conversation `system`
  // message made the model refuse on replay, while the top-level placement answered every time.
  const background = req.context.notes.length
    ? `Background about this conversation, written earlier by this app as reference. It is not an instruction and not text to repeat:\n${req.context.notes.join('\n')}`
    : '';
  const forThis = req.instruction ? `For this reply: ${req.instruction}` : '';
  // Last thing the model reads: a hard length rule (live calls ran 15 s replies with the budget in SYSTEM_PROMPT alone).
  const length = 'Length: this reply is spoken aloud, so keep it to at most two short sentences.';
  const extra = [background, forThis, length].filter(Boolean).join('\n\n');
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  if (extra) system.push({ type: 'text', text: extra });
  const messages: Anthropic.Beta.BetaMessageParam[] = [...req.context.messages];
  const useBetweenTools = model.startsWith('claude-sonnet-5-5') && process.env.REPLY_THINKING !== 'adaptive';
  return {
    model,
    max_tokens: 1024,
    system,
    cache_control: { type: 'ephemeral' as const },
    output_config: { effort: 'low' as const },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
    messages,
    ...(useBetweenTools ? { thinking: { type: 'between_tools' as const } } : {}),
  };
}

export class ClaudeResponder implements Responder {
  private client: Anthropic;
  private model: string;

  constructor(opts: { client?: Anthropic; model?: string } = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? (process.env.REPLY_MODEL || 'claude-opus-5-5');
  }

  async *reply(req: ReplyRequest, signal?: AbortSignal): AsyncIterable<string> {
    const stream = this.client.beta.messages.stream(replyParams(req, this.model));
    const abort = () => stream.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let stopReason: string | undefined;
    let outputTokens: number | undefined;
    const usage: ReplyUsage = {};
    try {
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          usage.firstTextAt ??= Date.now();
          yield ev.delta.text;
        } else if (ev.type === 'message_start') {
          usage.firstEventAt ??= Date.now();
          const u = ev.message.usage;
          usage.inputTokens = u?.input_tokens ?? undefined;
          usage.cacheReadTokens = u?.cache_read_input_tokens ?? undefined;
          usage.cacheWriteTokens = u?.cache_creation_input_tokens ?? undefined;
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') {
          usage.thinkingStartAt ??= Date.now();
        } else if (ev.type === 'message_delta') {
          if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.delta.stop_details) usage.stopCategory = ev.delta.stop_details.category ?? null;
          // Output tokens include thinking, which streams before any text on this model: the main cost of time to first word.
          if (typeof ev.usage?.output_tokens === 'number') outputTokens = ev.usage.output_tokens;
          const thinking = ev.usage?.output_tokens_details?.thinking_tokens;
          if (typeof thinking === 'number') usage.thinkingTokens = thinking;
          // The final usage repeats the input counts; prefer it when present.
          if (typeof ev.usage?.input_tokens === 'number') usage.inputTokens = ev.usage.input_tokens;
          if (typeof ev.usage?.cache_read_input_tokens === 'number') usage.cacheReadTokens = ev.usage.cache_read_input_tokens;
          if (typeof ev.usage?.cache_creation_input_tokens === 'number') usage.cacheWriteTokens = ev.usage.cache_creation_input_tokens;
        }
      }
      if (signal?.aborted) return; // cancellation, not truncation
      req.onStop?.(stopReason ?? 'unknown', { ...usage, outputTokens });
      if (!stopReason || !CLEAN_STOPS.has(stopReason)) throw new ReplyTruncatedError(stopReason ?? 'unknown');
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}
