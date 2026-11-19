import type { Op, RouteDecision, Router } from '../../src/route/types.js';
import type { Responder } from '../../src/reply/responder.js';
import type { Namer } from '../../src/reply/namer.js';
import type { Digester } from '../../src/reply/digest.js';
import type { Summarizer, SessionSummary } from '../../src/reply/summary.js';
import type { Session } from '../../src/tree/types.js';

/** Returns `summary` (or rejects when given an Error). Records each call's session id. */
export function fakeSummarizer(summary: SessionSummary | ((s: Session) => SessionSummary) | Error): Summarizer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async summarize(s) {
      calls.push(s.id);
      if (summary instanceof Error) throw summary;
      return typeof summary === 'function' ? summary(s) : summary;
    },
  };
}

export function fakeRouter(...ops: Op[]): Router {
  const queue = [...ops];
  return {
    async route(): Promise<RouteDecision> {
      const op = queue.shift() ?? { kind: 'continue' as const };
      return { op, intent: null, by: 'jev', ms: 1, reason: '' };
    },
  };
}

export function fakeResponder(chunks: string[] | Error, failAfter?: number): Responder {
  return {
    async *reply() {
      if (chunks instanceof Error) throw chunks;
      for (let i = 0; i < chunks.length; i++) {
        if (failAfter !== undefined && i >= failAfter) throw new Error('mid-stream failure');
        yield chunks[i];
      }
      if (failAfter !== undefined && failAfter >= chunks.length) throw new Error('mid-stream failure');
    },
  };
}

export function fakeNamer(name: string | null): Namer {
  return { async name() { return name; } };
}

/** Returns `text` (or `text(name)`), or rejects when given an Error. Records each call's name. */
export function fakeDigester(text: string | ((name: string) => string) | Error): Digester & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async digest(name) {
      calls.push(name);
      if (text instanceof Error) throw text;
      return typeof text === 'function' ? text(name) : text;
    },
  };
}

/** Yields nothing until the AbortSignal fires, then throws (like an aborted SDK stream). */
export function slowResponder(): Responder {
  return {
    async *reply(_input, signal) {
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      yield 'never';
    },
  };
}

/** Yields the first chunks, then blocks on `gate` (ignoring any signal) before yielding the rest. */
export function gatedResponder(first: string[], gate: Promise<void>, rest: string[] = []): Responder {
  return {
    async *reply() {
      for (const c of first) yield c;
      await gate;
      for (const c of rest) yield c;
    },
  };
}
