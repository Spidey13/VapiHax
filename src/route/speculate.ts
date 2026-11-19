import type { Session } from '../tree/types.js';
import type { TurnTrace } from '../trace.js';
import { buildRouteInput } from './input.js';
import type { RouteDecision, Router } from './types.js';

/** Lower-case, collapse whitespace, strip trailing `.,!?` and surrounding quotes. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/[.,!?]+$/, '')
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
}

interface Entry { revision: number; text: string; decision: RouteDecision }

/**
 * Routes on a stable partial transcript (same text twice in a row) so the decision is ready when the final arrives.
 * Works on a copy of the session; never mutates it. One cached decision per session.
 */
export class Speculator {
  runs = 0;
  private lastPartial = new Map<string, string>();
  private cache = new Map<string, Entry>();
  /** The routing currently running per session; repeats of the same key don't route again. lookup ignores it. */
  private inflight = new Map<string, { revision: number; text: string }>();

  constructor(private readonly router: Router) {}

  /** Resolves true when this partial became stable and a new speculation was routed. */
  async onPartial(s: Session, text: string, trace?: TurnTrace): Promise<boolean> {
    const norm = normalise(text);
    const prev = this.lastPartial.get(s.id);
    this.lastPartial.set(s.id, norm);
    if (!norm || prev !== norm) return false;
    if (trace) trace.stablePartialAt ??= Date.now();
    const hit = this.cache.get(s.id);
    if (hit && hit.revision === s.revision && hit.text === norm) return false;
    const revision = s.revision;
    const flying = this.inflight.get(s.id);
    if (flying && flying.revision === revision && flying.text === norm) return false;
    const marker = { revision, text: norm };
    this.inflight.set(s.id, marker); // a newer key replaces the marker
    this.runs++;
    const input = buildRouteInput(structuredClone(s), text);
    let decision: RouteDecision;
    try {
      decision = await this.router.route(input);
    } finally {
      if (this.inflight.get(s.id) === marker) this.inflight.delete(s.id);
    }
    // Store only if nothing moved while routing; an in-flight speculation is never awaited by lookup.
    // Never store a fallback: a timed-out or failed speculation would otherwise force `continue` on the final turn
    // instead of letting it route again.
    if (decision.by === 'jev' && this.lastPartial.get(s.id) === norm) this.cache.set(s.id, { revision, text: norm, decision });
    return true;
  }

  /** A completed cached decision for exactly this session state and text, else null. */
  lookup(s: Session, finalText: string, trace?: TurnTrace): RouteDecision | null {
    const e = this.cache.get(s.id);
    if (!e || e.revision !== s.revision || e.text !== normalise(finalText)) return null;
    if (trace) trace.speculationHit = true;
    return e.decision;
  }

  endUtterance(sessionId: string): void {
    this.cache.delete(sessionId);
    this.inflight.delete(sessionId);
    this.lastPartial.delete(sessionId);
  }
}
