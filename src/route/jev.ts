import { createHash } from 'node:crypto';
import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';
import { decide } from './policy.js';
import type { RawAnswers, RouteDecision, RouteInput, Router } from './types.js';

const DEFAULT_TIMEOUT_MS = 700;

/** Question texts and choices, one place, so the cache version below tracks exactly what Jev is asked. */
const SPEC = {
  intent: {
    question: 'What is the speaker doing with this utterance, relative to the thread they are in?',
    choices: {
      continue: 'continuing the current thread',
      newDirection: 'starting a different option, idea or approach',
      correction: 'correcting something they said earlier',
      switchBack: 'returning to another thread they discussed before',
      park: 'asking to set the current thought aside for later',
      scratch: 'taking back or discarding what they just said (scratch that, forget that, never mind, ignore that)',
      recap: 'asking where they were or what they have covered',
      compare: 'asking how two threads differ',
      merge: 'asking to combine two threads',
    },
  },
  target: 'Which other thread is the speaker referring to, if any?',
  detailNotDirection: 'Does the speaker change a specific detail (a number, date, name) of what they said, rather than the overall direction?',
  takesUpSuggestion: "Is the speaker adopting a different option or idea that the assistant just proposed as an alternative to the current plan (not merely agreeing, confirming, or answering the assistant's question)?",
};

export function hashSpec(spec: unknown): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 12);
}

/** Changes whenever a question text or choice changes; part of every eval cache key. */
export const ROUTER_SPEC_VERSION = hashSpec(SPEC);

/** The `systemOne` request for one utterance. Exported for the test and the eval script. */
export function jevRequest(input: RouteInput) {
  const { utterance, current, others } = input;
  const targets: Record<string, string> = {};
  for (const o of others) targets[o.id] = `${o.name}: ${o.summary}`;
  targets.none = 'no other thread';
  return {
    state: {
      utterance,
      currentThread: { name: current.name, lastUser: current.lastUser, lastAssistant: current.lastAssistant, isTentative: current.provisional },
      otherThreads: others.map(({ name, summary }) => ({ name, summary })),
    },
    questions: {
      intent: choice(SPEC.intent.question, SPEC.intent.choices),
      target: choice(SPEC.target, targets),
      detailNotDirection: noul(SPEC.detailNotDirection),
      takesUpSuggestion: noul(SPEC.takesUpSuggestion),
    },
  };
}

/** Router that never changes anything. */
export class NullRouter implements Router {
  async route(_input: RouteInput): Promise<RouteDecision> {
    return { op: { kind: 'continue' }, intent: null, by: 'fallback', ms: 0, reason: 'router disabled' };
  }
}

/** Routes an utterance with Jev; timeout or any error falls back to `continue`. */
export class JevRouter implements Router {
  private client?: { systemOne: TypeSafeClient['systemOne'] };
  private readonly timeoutMs: number;

  constructor(opts: { client?: { systemOne: TypeSafeClient['systemOne'] }; timeoutMs?: number } = {}) {
    this.client = opts.client;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async route(input: RouteInput): Promise<RouteDecision> {
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();
    try {
      this.client ??= new TypeSafeClient({ timeout: this.timeoutMs, retry: { maxRetries: 0 } });
      const call = this.client.systemOne(jevRequest(input), { signal: ac.signal });
      call.catch(() => {}); // a late failure after the timeout must not be unhandled
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort(); // cancel the request once the race is lost
          reject(Object.assign(new Error('timeout'), { name: 'timeout' }));
        }, this.timeoutMs);
      });
      const { answers } = await Promise.race([call, timeout]);
      const raw: RawAnswers = {
        intent: { choice: answers.intent.choice, confidence: answers.intent.confidence },
        target: { choice: answers.target.choice, confidence: answers.target.confidence },
        detailNotDirection: answers.detailNotDirection.noul,
        takesUpSuggestion: answers.takesUpSuggestion.noul,
      };
      return { ...decide(raw, input), by: 'jev', ms: elapsed(), raw };
    } catch (e) {
      return { op: { kind: 'continue' }, intent: null, by: 'fallback', ms: elapsed(), reason: e instanceof Error ? e.name : 'error' };
    } finally {
      clearTimeout(timer);
    }
  }
}
