import type { Express, Request, Response } from 'express';
import type { Deps } from '../server.js';
import type { TurnTrace } from '../trace.js';
import { secretOk } from './customLlm.js';
import { stripLeading } from './reconcile.js';
import { FILLERS } from '../reply/filler.js';

const logged = new Set<string>();
/** Log only the KEYS of the first body of each kind, to verify the live envelope. Never values. */
export function logKeysOnce(kind: string, body: unknown): void {
  if (logged.has(kind)) return;
  logged.add(kind);
  const b = (body ?? {}) as Record<string, unknown>;
  const msg = b.message && typeof b.message === 'object' ? Object.keys(b.message as object) : undefined;
  console.log(JSON.stringify({ envelope: kind, keys: Object.keys(b), messageKeys: msg, callKeys: b.call && typeof b.call === 'object' ? Object.keys(b.call as object) : undefined }));
}

/** The in-progress trace for this utterance. */
export function currentTrace(deps: Deps, sessionId: string, from: 'partial' | 'llm' | 'final'): TurnTrace {
  return deps.traces.current(sessionId, from);
}

/** The last `assistant.speechStarted` turn number seen per session, so each turn is stamped once. */
const lastPlaybackTurn = new WeakMap<object, number>();

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
      const session = sessionId ? deps.sessions.get(sessionId) : undefined;
      if (!session || session.ended) return; // an ended session is read-only: no speculation, no epoch changes
      const type = String(m?.type ?? '');

      // `user-interrupted` always cuts the reply. A bare user speech start cuts it only before the first sentence
      // is written: after that, backchannels must not stop a reply Vapi itself did not interrupt.
      if (type === 'speech-update' && m.role === 'user' && m.status === 'started') deps.spoken.userStarted(session.id, Date.now());
      // The assistant was speaking (a filler-only turn is told apart later, by Vapi turn): playback evidence.
      if (type === 'user-interrupted') {
        deps.spoken.interrupted(session.id, Date.now()); // also playback evidence, unless the cut turn only played fillers
      }
      if (type === 'speech-update' && m.role === 'assistant' && m.status === 'started') {
        deps.spoken.assistantStarted(session.id, Date.now(), typeof m.turn === 'number' && Number.isFinite(m.turn) ? m.turn : undefined);
      }
      if (type === 'speech-update' && m.role === 'assistant' && m.status === 'stopped') deps.spoken.assistantStopped(session.id, Date.now());
      if (type.startsWith('transcript') && m.role === 'assistant' && typeof m.transcript === 'string') {
        deps.spoken.assistantTranscript(session.id, m.transcript, m.transcriptType === 'final' || type.includes('final'), Date.now());
      }
      const userStarted = type === 'speech-update' && m.role === 'user' && m.status === 'started' && !deps.replyWriting.has(session.id);
      if (type === 'user-interrupted' || userStarted) {
        deps.responseEpoch.set(session.id, (deps.responseEpoch.get(session.id) ?? 0) + 1);
        deps.switchedDuring.delete(session.id); // speech is the cause now: Vapi resends, no rebuild
        return;
      }
      if (type === 'assistant.speechStarted') {
        // Model text (not a filler) is being played: evidence the caller heard a reply.
        const said = typeof m.text === 'string' ? m.text : '';
        const spokenTurn = typeof m.turn === 'number' && Number.isFinite(m.turn) ? m.turn : undefined;
        if (stripLeading(said, FILLERS) !== '') deps.spoken.modelPlayback(session.id, Date.now(), spokenTurn);
        else if (said && spokenTurn !== undefined) deps.spoken.fillerOnly(session.id, spokenTurn);
        // Provider playback evidence (not server emission). Only a new turn number counts; no text is logged.
        const turn = typeof m.turn === 'number' && Number.isFinite(m.turn) ? m.turn : undefined;
        if (turn !== undefined && lastPlaybackTurn.get(session) !== turn) {
          lastPlaybackTurn.set(session, turn);
          const at = Date.now();
          const traces = deps.traces.list(session.id);
          const emitted = [...traces].reverse().find((t) => t.firstEmitAt !== undefined && t.firstEmitAt <= at);
          if (emitted && emitted.playbackStartedAt === undefined) emitted.playbackStartedAt = at;
          const source = typeof m.source === 'string' ? m.source.slice(0, 32) : undefined;
          console.log(JSON.stringify({ sessionId: session.id, event: 'playback', turn, source, at }));
        }
        return;
      }
      if (type.startsWith('transcript') && m.role === 'user' && typeof m.transcript === 'string') {
        const final = m.transcriptType === 'final' || type.includes('final');
        deps.spoken.userTranscript(session.id, final, Date.now(), m.transcript.slice(0, 200));
        if (final) currentTrace(deps, session.id, 'final').finalAt = Date.now();
        else {
          const trace = currentTrace(deps, session.id, 'partial');
          trace.firstPartialAt ??= Date.now();
          void deps.speculator?.onPartial(session, m.transcript, trace).catch(() => {});
        }
      }
    } catch {
      /* events are best-effort */
    }
  });
}
