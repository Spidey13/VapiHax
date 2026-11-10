import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { Deps } from '../server.js';
import { handleTurn, settle, type Prefetched } from '../engine/turn.js';
import { currentTrace, logKeysOnce } from './events.js';
import { isStillCurrent } from '../engine/respond.js';

type Lock = <T>(id: string, fn: () => Promise<T>) => Promise<T>;

export const UNBOUND_REPLY = "This call isn't linked to a case yet.";
const NO_INPUT_REPLY = 'I did not catch that. Could you say it again?';

export function secretOk(secret: string, req: Request): boolean {
  const candidates = [req.header('x-vapi-secret'), req.header('authorization')?.replace(/^Bearer /, '')];
  const want = Buffer.from(secret);
  return candidates.some((c) => {
    if (!c) return false;
    const got = Buffer.from(c);
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

/** Content may be a string or an OpenAI-style array of parts; parse defensively. */
function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join(' ');
  }
  return '';
}

function lastUserText(body: unknown): string {
  const msgs = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(msgs)) return '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: unknown; content?: unknown } | null;
    if (m && m.role === 'user') return contentText(m.content).trim();
  }
  return '';
}

function sentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

export function mountVapi(app: Express, deps: Deps, lock: Lock): void {
  app.post('/vapi/chat/completions', async (req: Request, res: Response) => {
    const t0 = performance.now();
    if (!deps.vapiSecret) return void res.status(503).json({ error: 'custom LLM secret not configured' });
    if (!secretOk(deps.vapiSecret, req)) return void res.status(401).json({ error: 'unauthorized' });

    const body = req.body ?? {};
    logKeysOnce('llm', body);
    const callId = typeof body?.call?.id === 'string' ? body.call.id : '';
    // Binding is by explicit call id only. No "latest session" and no transcript similarity.
    const sessionId = callId ? deps.bindings.get(callId) : undefined;
    const state = sessionId ? deps.store.getCase(sessionId) : undefined;
    const userText = lastUserText(body);

    let reply: string;
    let revision = -1;
    if (!state) {
      reply = UNBOUND_REPLY;
    } else if (!userText) {
      reply = NO_INPUT_REPLY;
      revision = state.revision;
    } else {
      const trace = currentTrace(deps, state.sessionId, 'llm');
      trace.llmRequestAt = Date.now();
      reply = await lock(state.sessionId, async () => {
        const sel = await deps.prefetch.lookup(state, userText, deps.interpreter);
        const pre: Prefetched | undefined = sel ? { sel, used: false } : undefined;
        let r = await handleTurn(state, userText, 'voice', deps.interpreter, Date.now(), pre);
        trace.prefetchHit = r.prefetchHit === true;
        deps.prefetch.endUtterance(state.sessionId);
        // Stale guard immediately before emitting: recompute once from current facts if something moved.
        if (!isStillCurrent(state, r.stamp)) r = settle(state, 'voice');
        return r.reply;
      });
      revision = state.revision;
    }

    const stream = body.stream === true;
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = 'setup-relay';
    let firstByteMs = 0;
    const epochAtStart = state ? (deps.responseEpoch.get(state.sessionId) ?? 0) : 0;

    if (stream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const parts = sentences(reply);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        // Interrupted by the user: stop emitting further sentences.
        if (state && (deps.responseEpoch.get(state.sessionId) ?? 0) !== epochAtStart) break;
        const piece = (i === 0 ? '' : ' ') + p;
        res.write(chunk(i === 0 ? { role: 'assistant', content: piece } : { content: piece }, null));
        if (i === 0) {
          firstByteMs = Math.round(performance.now() - t0);
          if (state) currentTrace(deps, state.sessionId, 'llm').firstByteAt = Date.now();
        }
        await new Promise((r) => setTimeout(r, 0)); // yield so an interrupt event can land between chunks
      }
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      });
      firstByteMs = Math.round(performance.now() - t0);
    }
    // One trace line per request; deliberately no transcript text.
    console.log(JSON.stringify({ sessionId: state?.sessionId ?? null, callId: callId || null, revision, msReceivedToFirstByte: firstByteMs }));
  });
}
