import { describe, it, expect } from 'vitest';
import { replyParams, ClaudeResponder, ReplyTruncatedError } from '../src/reply/responder.js';
import { SYSTEM_PROMPT } from '../src/reply/prompts.js';

const ctx = { messages: [{ role: 'user' as const, content: 'podcast?' }], notes: ['The user corrected something earlier: "four". Treat the corrected version as current.'] };

describe('replyParams', () => {
  it('pins model, effort, length, caching and refusal fallback', () => {
    const p = replyParams({ context: { messages: ctx.messages, notes: [] } }, 'claude-opus-5-5');
    expect(p).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 1024, output_config: { effort: 'low' }, cache_control: { type: 'ephemeral' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect(p.system[0]).toEqual({ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } });
    expect(p.system[1]!.text).toMatch(/^Length: /);
    expect(p.messages).toEqual(ctx.messages);
  });
  it('puts notes and the instruction in a second, uncached system block, never a system message', () => {
    const p = replyParams({ context: ctx, instruction: 'Ask which thread.' }, 'm');
    expect(p.messages.some((m: { role: string }) => m.role === 'system')).toBe(false);
    expect(p.system[0]!.text).toBe(SYSTEM_PROMPT);
    expect(p.system[1]!.text).toContain(ctx.notes[0]);
    expect(p.system[1]!.text).toContain('For this reply: Ask which thread.');
    expect(p.system[1]!.text).toMatch(/at most two short sentences\.$/);
    expect(p.system[1]).not.toHaveProperty('cache_control');
  });
  it('uses between_tools thinking only on Sonnet 5.5, unless REPLY_THINKING=adaptive', () => {
    const req = { context: { messages: ctx.messages, notes: [] } };
    expect(replyParams(req, 'claude-sonnet-5-5').thinking).toEqual({ type: 'between_tools' });
    expect(replyParams(req, 'claude-opus-5-5')).not.toHaveProperty('thinking');
    const prev = process.env.REPLY_THINKING;
    process.env.REPLY_THINKING = 'adaptive';
    try { expect(replyParams(req, 'claude-sonnet-5-5')).not.toHaveProperty('thinking'); }
    finally { if (prev === undefined) delete process.env.REPLY_THINKING; else process.env.REPLY_THINKING = prev; }
  });
  it('reads the refusal category from the stream', async () => {
    const fakeStream = {
      async *[Symbol.asyncIterator]() { yield { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } } }; },
      abort() { /* none */ },
    };
    const client = { beta: { messages: { stream: () => fakeStream } } } as any;
    let cat: unknown;
    await expect((async () => { for await (const _ of new ClaudeResponder({ client, model: 'm' }).reply({ context: ctx, onStop: (_r, u) => { cat = u?.stopCategory; } })) { /* none */ } })()).rejects.toBeInstanceOf(ReplyTruncatedError);
    expect(cat).toBe('cyber');
  });
});

describe('ClaudeResponder', () => {
  it('yields text deltas from the stream and aborts it on signal', async () => {
    let aborted = false;
    const fakeStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Then ' } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'guests matter.' } };
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
      },
      abort() { aborted = true; },
    };
    const client = { beta: { messages: { stream: () => fakeStream } } } as any;
    const out: string[] = [];
    for await (const t of new ClaudeResponder({ client, model: 'm' }).reply({ context: ctx })) out.push(t);
    expect(out.join('')).toBe('Then guests matter.');
    const ac = new AbortController(); ac.abort();
    for await (const _ of new ClaudeResponder({ client, model: 'm' }).reply({ context: ctx }, ac.signal)) { /* none */ }
    expect(aborted).toBe(true);
  });
});

describe('ClaudeResponder stop reasons', () => {
  const textEv = (text: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
  const stopEv = (stop_reason: string) => ({ type: 'message_delta', delta: { stop_reason } });
  const clientOf = (events: object[], throwAfter?: Error) =>
    ({
      beta: {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              for (const e of events) yield e;
              if (throwAfter) throw throwAfter;
            },
            abort() {},
          }),
        },
      },
    }) as any;
  const drain = async (events: object[], onStop?: (r: string) => void, signal?: AbortSignal, err?: Error) => {
    const out: string[] = [];
    let thrown: unknown;
    try {
      for await (const t of new ClaudeResponder({ client: clientOf(events, err), model: 'm' }).reply({ context: ctx, ...(onStop ? { onStop } : {}) }, signal)) out.push(t);
    } catch (e) {
      thrown = e;
    }
    return { out, thrown };
  };

  it('passes the output token count (thinking included) to onStop', async () => {
    const seen: (number | undefined)[] = [];
    const { thrown } = await drain([textEv('Fine.'), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 412 } }], ((_r: string, u?: { outputTokens?: number }) => seen.push(u?.outputTokens)) as any);
    expect(thrown).toBeUndefined();
    expect(seen).toEqual([412]);
  });
  it('reports end_turn and stop_sequence through onStop and ends cleanly', async () => {
    for (const reason of ['end_turn', 'stop_sequence']) {
      const seen: string[] = [];
      const { out, thrown } = await drain([textEv('Fine.'), stopEv(reason)], (r) => seen.push(r));
      expect(thrown).toBeUndefined();
      expect(out).toEqual(['Fine.']);
      expect(seen).toEqual([reason]);
    }
  });
  it.each(['max_tokens', 'model_context_window_exceeded', 'refusal'])('throws ReplyTruncatedError for %s after the text already yielded', async (reason) => {
    const seen: string[] = [];
    const { out, thrown } = await drain([textEv('A good start. '), textEv('and a brok'), stopEv(reason)], (r) => seen.push(r));
    expect(out.join('')).toBe('A good start. and a brok');
    expect(thrown).toBeInstanceOf(ReplyTruncatedError);
    expect((thrown as ReplyTruncatedError).stopReason).toBe(reason);
    expect(seen).toEqual([reason]);
  });
  it('treats a stream that ended without a stop reason as truncated (unknown)', async () => {
    const seen: string[] = [];
    const { thrown } = await drain([textEv('Half.')], (r) => seen.push(r));
    expect(thrown).toBeInstanceOf(ReplyTruncatedError);
    expect((thrown as ReplyTruncatedError).stopReason).toBe('unknown');
    expect(seen).toEqual(['unknown']);
  });
  it('treats a tool-only stop as a failure', async () => {
    const { thrown } = await drain([stopEv('tool_use')]);
    expect(thrown).toBeInstanceOf(ReplyTruncatedError);
  });
  it('lets SDK errors through as themselves', async () => {
    const boom = new Error('sdk boom');
    const { out, thrown } = await drain([textEv('Hi. ')], undefined, undefined, boom);
    expect(out).toEqual(['Hi. ']);
    expect(thrown).toBe(boom);
  });
  it('an aborted stream is cancellation, not truncation', async () => {
    const ac = new AbortController();
    ac.abort();
    const { thrown } = await drain([textEv('Hi.')], undefined, ac.signal);
    expect(thrown).toBeUndefined();
  });
});
