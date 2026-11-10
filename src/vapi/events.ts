import type { Express, Request, Response } from 'express';
import type { Deps } from '../server.js';
import type { Trace } from '../engine/prefetch.js';
import { secretOk } from './customLlm.js';

const logged = new Set<string>();
/** Log only the KEYS of the first body of each kind, to verify the live envelope. Never values. */
export function logKeysOnce(kind: string, body: unknown): void {
  if (logged.has(kind)) return;
  logged.add(kind);
  const b = (body ?? {}) as Record<string, unknown>;
  const msg = b.message && typeof b.message === 'object' ? Object.keys(b.message as object) : undefined;
  console.log(JSON.stringify({ envelope: kind, keys: Object.keys(b), messageKeys: msg, callKeys: b.call && typeof b.call === 'object' ? Object.keys(b.call as object) : undefined }));
}

/** The in-progress trace for this utterance, creating one if the last was already sent to the LLM. */
export function currentTrace(deps: Deps, sessionId: string, from: 'partial' | 'llm' | 'final'): Trace {
  const list = deps.traces.get(sessionId) ?? [];
  deps.traces.set(sessionId, list);
  let cur = list[list.length - 1];
  const done = cur?.firstByteAt !== undefined;
  const startsNew = !cur || done || (from === 'partial' && cur.llmRequestAt !== undefined);
  if (startsNew) {
    cur = {};
    list.push(cur);
    if (list.length > 50) list.shift();
  }
  return cur!;
}

export function mountEvents(app: Express, deps: Deps): void {
  app.post('/vapi/events', (req: Request, res: Response) => {
    if (!deps.vapiSecret) return void res.status(503).json({ error: 'secret not configured' });
    if (!secretOk(deps.vapiSecret, req)) return void res.status(401).json({ error: 'unauthorized' });
    res.status(200).json({}); // ack first; work after
    try {
      logKeysOnce('events', req.body);
      const m = req.body?.message;
      const callId = typeof m?.call?.id === 'string' ? m.call.id : '';
      const sessionId = callId ? deps.bindings.get(callId) : undefined; // binding map only
      const state = sessionId ? deps.store.getCase(sessionId) : undefined;
      if (!state) return;
      const type = String(m?.type ?? '');

      if (type === 'user-interrupted' || (type === 'speech-update' && m.role === 'user' && m.status === 'started')) {
        deps.responseEpoch.set(state.sessionId, (deps.responseEpoch.get(state.sessionId) ?? 0) + 1);
        return;
      }
      if (type.startsWith('transcript') && m.role === 'user' && typeof m.transcript === 'string') {
        const final = m.transcriptType === 'final' || type.includes('final');
        if (final) {
          currentTrace(deps, state.sessionId, 'final').finalAt = Date.now();
          return;
        }
        const trace = currentTrace(deps, state.sessionId, 'partial');
        trace.firstPartialAt ??= Date.now();
        // Partial: interpreted on a clone only; facts are never mutated here.
        void deps.prefetch.onPartial(state, m.transcript, deps.interpreter, trace).catch(() => {});
      }
    } catch {
      /* events are best-effort */
    }
  });
}
