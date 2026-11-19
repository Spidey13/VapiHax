import { FillerPicker } from './reply/filler.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Branch, Session, Turn } from './tree/types.js';
import { SessionStore } from './tree/store.js';
import { getBranch, pathTurns } from './tree/tree.js';
import { topicMemberIds } from './tree/history.js';
import { switchWithLimit } from './turn/apply.js';
import { sheetsView } from './view/sheets.js';
import { lastUndoRecord, runTurn, type TurnDeps } from './turn/pipeline.js';
import type { RouteDecision } from './route/types.js';
import { JevRouter, NullRouter } from './route/jev.js';
import { ClaudeResponder, type Responder, type ReplyRequest } from './reply/responder.js';
import { ClaudeNamer, type Namer } from './reply/namer.js';
import { ClaudeDigester, type Digester } from './reply/digest.js';
import { ClaudeSummarizer, fallbackSummary, listedBranchIds, normaliseSummary, type Summarizer, type SessionSummary } from './reply/summary.js';
import { layoutTree } from './view/layout.js';
import { summaryMarkdown } from './view/summaryMarkdown.js';
import { Speculator } from './route/speculate.js';
import { TraceStore } from './trace.js';
import { mountVapi, trimLastReplyToSpoken } from './vapi/customLlm.js';
import { mountEvents } from './vapi/events.js';
import { ENDPOINTING } from './vapi/assistantConfig.js';
import { SpokenLog } from './vapi/spoken.js';

export const MAX_TEXT = 1000;

export interface Deps extends TurnDeps {
  sessions: SessionStore;
  summarizer: Summarizer;
  /** How long End waits for the summarizer before using the fallback. Default 20 s. */
  summaryTimeoutMs?: number;
  /** sessionId -> bearer token */
  tokens: Map<string, string>;
  /** Vapi callId -> sessionId. Only ever set through an authenticated /bind. */
  bindings: Map<string, string>;
  vapiSecret?: string;
  /** Bumped on user interruption; SSE writers stop when it changes. */
  responseEpoch: Map<string, number>;
  /** Sessions whose current reply has already written a sentence to Vapi (set by the SSE writer, cleared when the reply ends). */
  replyWriting: Set<string>;
  /** Sessions whose in-flight reply was interrupted by a tap-switch (not speech); set by the switch route, consumed by the SSE writer. */
  switchedDuring: Set<string>;
  /** Most recent routing decision per session, shown by GET. */
  lastDecisions: Map<string, RouteDecision>;
  publicConfig: { vapiPublicKey?: string; assistantId?: string };
  /** Routes on stable partial transcripts; built from `router` when not supplied. */
  speculator?: Speculator;
  /** What the events webhook showed about the caller's speech and model playback. Evidence only. */
  spoken: SpokenLog;
}

/** Claude clients are built on first use so the server boots without ANTHROPIC_API_KEY; a turn then falls into the fixed error reply. */
function lazyResponder(): Responder {
  let inst: Responder | undefined;
  return { reply: (req: ReplyRequest, signal?: AbortSignal) => (inst ??= new ClaudeResponder()).reply(req, signal) };
}

function lazyNamer(): Namer {
  let inst: Namer | undefined;
  return { name: (u: string) => (inst ??= new ClaudeNamer()).name(u) };
}

function lazySummarizer(): Summarizer {
  let inst: Summarizer | undefined;
  return { summarize: (s, signal) => (inst ??= new ClaudeSummarizer()).summarize(s, signal) };
}

function lazyDigester(): Digester {
  let inst: Digester | undefined;
  return { digest: (n, t, signal) => (inst ??= new ClaudeDigester()).digest(n, t, signal) };
}

export function defaultDeps(overrides: Partial<Deps> = {}): Deps {
  const deps: Deps = {
    router: process.env.TYPESAFE_API_KEY && process.env.JEV_ENABLED !== '0' ? new JevRouter() : new NullRouter(),
    responder: lazyResponder(),
    namer: lazyNamer(),
    digester: lazyDigester(),
    summarizer: lazySummarizer(),
    traces: new TraceStore(),
    filler: new FillerPicker(),
    sessions: new SessionStore(),
    tokens: new Map(),
    bindings: new Map(),
    vapiSecret: process.env.VAPI_CUSTOM_LLM_SECRET || undefined,
    responseEpoch: new Map(),
    replyWriting: new Set(),
    switchedDuring: new Set(),
    lastDecisions: new Map(),
    spoken: new SpokenLog(),
    publicConfig: { vapiPublicKey: process.env.VAPI_PUBLIC_KEY || undefined, assistantId: process.env.VAPI_ASSISTANT_ID || undefined },
    ...overrides,
  };
  deps.speculator ??= new Speculator(deps.router);
  return deps;
}

/**
 * Publishes a turn's decision as soon as it is applied, and puts the previous one back if the turn is rolled back.
 * Known trade-offs: a client poll can see the new decision for a moment before a rollback restores the previous one,
 * and if `runTurn` throws after publishing, the decision stays published (the applied state was not rolled back either).
 * Use inside the session lock: `const pub = publishDecisions(deps, id); runTurn(..., { onDecision: pub.onDecision }); pub.settle(r)`.
 */
export function publishDecisions(deps: Pick<Deps, 'lastDecisions'>, id: string) {
  const prev = deps.lastDecisions.get(id);
  return {
    onDecision: (d: RouteDecision) => void deps.lastDecisions.set(id, d),
    settle: (r: { rolledBack?: boolean } | null) => {
      if (!r?.rolledBack) return;
      if (prev) deps.lastDecisions.set(id, prev);
      else deps.lastDecisions.delete(id);
    },
  };
}

export function stateView(s: Session, lastDecision?: RouteDecision, shareUrl?: string) {
  return {
    sessionId: s.id,
    epoch: s.epoch,
    revision: s.revision,
    hold: s.hold,
    currentBranchId: s.currentBranchId,
    branches: Object.values(s.branches) as Branch[],
    path: pathTurns(s, s.currentBranchId) as Turn[],
    sheets: sheetsView(s),
    lastDecision: lastDecision ?? null,
    ended: s.ended ? { at: s.ended.at, shareUrl: shareUrl ?? null } : null,
  };
}

function tokenOk(expected: string | undefined, header: string | undefined): boolean {
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Serialize work per session so overlapping turns cannot interleave. */
function makeLock() {
  const tails = new Map<string, Promise<unknown>>();
  return async function <T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    tails.set(id, run.catch(() => undefined));
    return run;
  };
}

export function createApp(deps: Deps = defaultDeps()): Express {
  const app = express();
  // Vapi resends the whole conversation on every request, so /vapi gets a larger limit.
  app.use('/vapi', express.json({ limit: '1mb' }));
  app.use('/api', express.json({ limit: '32kb' }));
  const lock = makeLock();
  // The Host-header fallback is acceptable only because the URL goes back to the token holder who made the request,
  // never to a third party. Set PUBLIC_URL in production.
  const shareUrlFor = (s: Session, req: Request) =>
    s.ended ? `${(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/s/${s.ended.shareId}` : undefined;
  const view = (s: Session, req?: Request) => stateView(s, deps.lastDecisions.get(s.id), req ? shareUrlFor(s, req) : undefined);
  const endedReply = (res: Response) => void res.status(409).json({ error: 'session ended' });

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    const s = deps.sessions.get(id);
    if (!s) return void res.status(404).json({ error: 'unknown session' });
    if (!tokenOk(deps.tokens.get(id), req.header('authorization'))) return void res.status(401).json({ error: 'bad token' });
    res.locals.session = s;
    next();
  };

  app.post('/api/sessions', (req, res) => {
    const s = deps.sessions.create();
    const token = randomBytes(32).toString('hex');
    deps.tokens.set(s.id, token);
    res.status(201).json({ sessionId: s.id, token, state: view(s, req) });
  });

  // Auth is checked before existence so an unauthenticated caller cannot probe session ids.
  app.use('/api/sessions/:id', (req, res, next) => {
    if (!tokenOk(deps.tokens.get(req.params.id), req.header('authorization'))) {
      return void res.status(deps.tokens.has(req.params.id) ? 401 : 404).json({ error: deps.tokens.has(req.params.id) ? 'bad token' : 'unknown session' });
    }
    next();
  });

  app.get('/api/sessions/:id', auth, (req, res) => res.json(view(res.locals.session, req)));

  app.post('/api/sessions/:id/turn', auth, async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, MAX_TEXT) : '';
    if (!text) return void res.status(400).json({ error: 'text required' });
    const s: Session = res.locals.session;
    if (s.ended) return endedReply(res);
    const r = await lock(s.id, async () => {
      if (s.ended) return null;
      const pub = publishDecisions(deps, s.id);
      const out = await runTurn(deps, s, text, { onDecision: pub.onDecision });
      pub.settle(out);
      return out;
    });
    if (!r) return endedReply(res);
    res.json({ reply: r.reply, decision: r.decision, state: view(s, req) });
  });

  app.post('/api/sessions/:id/switch', auth, async (req, res) => {
    const s: Session = res.locals.session;
    const branchId = req.body?.branchId;
    if (s.ended) return endedReply(res);
    if (typeof branchId !== 'string' || !getBranch(s, branchId)) return void res.status(400).json({ error: 'unknown branch' });
    // Interrupt any reply still streaming for this session before queueing behind it.
    deps.responseEpoch.set(s.id, (deps.responseEpoch.get(s.id) ?? 0) + 1);
    deps.switchedDuring.add(s.id);
    // Any branch set aside by the limit shows as a parked chip in the state view, so the returned names are not needed here.
    const done = await lock(s.id, async () => (s.ended ? false : (switchWithLimit(s, branchId, (deps.now ?? Date.now)()), true)));
    if (!done) return endedReply(res);
    res.json({ state: view(s, req) });
  });

  app.post('/api/sessions/:id/hold', auth, async (req, res) => {
    const hold = req.body?.hold;
    if (typeof hold !== 'boolean') return void res.status(400).json({ error: 'hold must be a boolean' });
    const s: Session = res.locals.session;
    if (s.ended) return endedReply(res);
    const done = await lock(s.id, async () => {
      if (s.ended) return false;
      s.hold = hold;
      return true;
    });
    if (!done) return endedReply(res);
    res.json({ state: view(s, req) });
  });

  app.post('/api/sessions/:id/end', auth, async (req, res) => {
    const s: Session = res.locals.session;
    // Same lock as turns: an in-flight turn finishes first, and a second end sees the first one's result.
    await lock(s.id, async () => {
      if (s.ended) return;
      // The last reply is stored as spoken, not as written: when the assistant is still mid-answer, give its closing
      // transcript a moment to arrive (it follows the stop), then cut the reply to what was said.
      const firstEmitAt = lastUndoRecord(s)?.firstEmitAt;
      if (firstEmitAt !== undefined) {
        const before = deps.spoken.spokenSince(s.id, firstEmitAt);
        for (let waited = 0; before.open && waited < 1500; waited += 100) {
          const now = deps.spoken.spokenSince(s.id, firstEmitAt);
          if (!now.open || now.finals > before.finals) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        trimLastReplyToSpoken(s, deps, 'end');
      }
      let summary: SessionSummary | null = null;
      if (listedBranchIds(s).length > 0) {
        try {
          let timer: NodeJS.Timeout | undefined;
          const ac = new AbortController();
          const timeout = new Promise<never>((_, rej) => {
            timer = setTimeout(() => {
              ac.abort();
              rej(new Error('summary timeout'));
            }, deps.summaryTimeoutMs ?? 20_000);
          });
          try {
            summary = await Promise.race([deps.summarizer.summarize(s, ac.signal), timeout]);
          } finally {
            clearTimeout(timer);
          }
        } catch {
          summary = fallbackSummary(s);
        }
        summary = normaliseSummary(s, summary);
      }
      deps.sessions.end(s, { at: (deps.now ?? Date.now)(), summary, shareId: randomBytes(16).toString('hex') });
      deps.responseEpoch.set(s.id, (deps.responseEpoch.get(s.id) ?? 0) + 1); // cut off any reply still streaming
    });
    res.json({ shareUrl: shareUrlFor(s, req), state: view(s, req) });
  });

  app.get('/api/sessions/:id/summary.md', auth, (_req, res) => {
    const s: Session = res.locals.session;
    if (!s.ended) return void res.status(409).json({ error: 'session not ended' });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="brainstorm-summary.md"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(summaryMarkdown(s));
  });

  // Share links: public and read-only. The payload is built field by field so no session id, token or turn id can leak in.
  const SHARE_ID = /^[0-9a-f]{32}$/;
  app.get('/api/share/:shareId', (req, res) => {
    const shareId = String(req.params.shareId);
    const s = SHARE_ID.test(shareId) ? deps.sessions.getByShareId(shareId) : undefined;
    if (!s?.ended) return void res.status(404).json({ error: 'not found' });
    // Only branches that were actually spoken in (plus their ancestors, to keep the tree connected): an empty fork or one
    // whose user turns were all scratched must not show, and its name may come from scratched text.
    const keep = new Set<string>();
    for (const id of listedBranchIds(s)) {
      for (let b: Branch | undefined = s.branches[id]; b && !keep.has(b.id); b = b.parentId !== null && Object.hasOwn(s.branches, b.parentId) ? s.branches[b.parentId] : undefined) keep.add(b.id);
    }
    // An ancestor kept only for connectivity was never spoken in: its name may come from scratched text, so it shows neutral.
    const listed = topicMemberIds(s); // representatives and the correction ancestors folded into them keep their names
    const branches = (Object.values(s.branches) as Branch[]).filter((b) => keep.has(b.id)).map((b) => (listed.has(b.id) ? b : { ...b, name: '…' }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      nothing: s.ended.summary === null,
      summary: s.ended.summary,
      branches: branches.map((b) => ({ id: b.id, name: b.name, status: b.status, origin: b.origin })),
      map: layoutTree(branches),
      showMap: listedBranchIds(s).length > 1,
      endedAt: s.ended.at,
    });
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  app.get('/s/:shareId', (req, res) => {
    const shareId = String(req.params.shareId);
    if (!SHARE_ID.test(shareId) || !deps.sessions.getByShareId(shareId)) return void res.status(404).type('text/plain').send('Not found');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(here, '..', 'public', 'share.html'));
  });

  app.post('/api/sessions/:id/bind', auth, (req, res) => {
    const callId = req.body?.callId;
    if (typeof callId !== 'string' || !callId || callId.length > 200) return void res.status(400).json({ error: 'callId required' });
    if ((res.locals.session as Session).ended) return void res.status(409).json({ error: 'session ended' });
    const existing = deps.bindings.get(callId);
    if (existing && existing !== req.params.id) return void res.status(409).json({ error: 'call already bound' });
    deps.bindings.set(callId, String(req.params.id));
    res.json({ bound: true });
  });

  app.get('/api/sessions/:id/trace', auth, (req, res) => res.json({ traces: deps.traces.list(String(req.params.id)) }));
  // Public key is browser-safe. The private key is never exposed.
  app.get('/api/config', (_req, res) => res.json({ ...deps.publicConfig, endpointing: { waitMs: Math.round((ENDPOINTING.waitSeconds + ENDPOINTING.onNoPunctuationSeconds) * 1000) } }));

  mountVapi(app, deps, lock);
  mountEvents(app, deps);

  app.use(express.static(path.join(here, '..', 'public')));
  return app;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  try {
    process.loadEnvFile?.();
  } catch {
    /* no .env is fine */
  }
  const port = Number(process.env.PORT) || 3000;
  const app = createApp(defaultDeps());
  // IPC belongs to `npm run live`: don't leave an orphan server if its launcher is killed.
  if (process.send) process.on('disconnect', () => process.exit(1));
  app.listen(port, (error?: Error) => {
    if (error) {
      console.error(`branch-voice could not listen on port ${port} (${(error as NodeJS.ErrnoException).code ?? 'listen error'})`);
      process.exit(1);
    }
    console.log(`branch-voice listening on http://localhost:${port}`);
    process.send?.({ type: 'ready' });
  });
}
