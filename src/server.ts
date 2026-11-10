import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { CaseStore } from './case/store.js';
import type { CaseState } from './case/types.js';
import { setFact } from './case/facts.js';
import { supersedeAttempts } from './case/attempts.js';
import { RuleInterpreter, type Interpreter } from './engine/interpret.js';
import { handleTurn, settle } from './engine/turn.js';
import { toJson, toMarkdown, BANNER } from './packet.js';
import { mountVapi } from './vapi/customLlm.js';

export interface Deps {
  store: CaseStore;
  interpreter: Interpreter;
  /** sessionId -> bearer token */
  tokens: Map<string, string>;
  /** Vapi callId -> sessionId. Only ever set through an authenticated /bind. */
  bindings: Map<string, string>;
  vapiSecret?: string;
}

export function defaultDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    store: new CaseStore(),
    interpreter: new RuleInterpreter(),
    tokens: new Map(),
    bindings: new Map(),
    vapiSecret: process.env.VAPI_CUSTOM_LLM_SECRET || undefined,
    ...overrides,
  };
}

export function stateView(s: CaseState) {
  return {
    banner: BANNER,
    sessionId: s.sessionId,
    epoch: s.epoch,
    revision: s.revision,
    facts: s.facts,
    currentCheck: s.currentCheck?.check ?? null,
    attempts: s.attempts,
    notices: s.notices,
    hypothetical: s.hypothetical,
    outcome: s.outcome,
    pendingQuestion: s.pendingQuestion ?? null,
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
  app.use(express.json({ limit: '32kb' }));
  const lock = makeLock();

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    const s = deps.store.getCase(id);
    if (!s) return void res.status(404).json({ error: 'unknown session' });
    if (!tokenOk(deps.tokens.get(id), req.header('authorization'))) return void res.status(401).json({ error: 'bad token' });
    res.locals.state = s;
    next();
  };

  app.post('/api/sessions', (_req, res) => {
    const s = deps.store.createCase();
    const token = randomBytes(32).toString('hex');
    deps.tokens.set(s.sessionId, token);
    res.status(201).json({ sessionId: s.sessionId, token, state: stateView(s) });
  });

  // Auth is checked before existence so an unauthenticated caller cannot probe session ids.
  app.use('/api/sessions/:id', (req, res, next) => {
    if (!tokenOk(deps.tokens.get(req.params.id), req.header('authorization'))) {
      return void res.status(deps.tokens.has(req.params.id) ? 401 : 404).json({ error: deps.tokens.has(req.params.id) ? 'bad token' : 'unknown session' });
    }
    next();
  });

  app.get('/api/sessions/:id', auth, (_req, res) => res.json(stateView(res.locals.state)));

  app.post('/api/sessions/:id/turn', auth, async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 1000) : '';
    if (!text.trim()) return void res.status(400).json({ error: 'text required' });
    const s: CaseState = res.locals.state;
    const r = await lock(s.sessionId, () => handleTurn(s, text, 'text', deps.interpreter));
    res.json({ reply: r.reply, state: stateView(s) });
  });

  app.patch('/api/sessions/:id/facts', auth, (req, res) => {
    const s: CaseState = res.locals.state;
    const { path: p, value } = req.body ?? {};
    if (typeof p !== 'string' || !(p in s.facts)) return void res.status(400).json({ error: 'unknown fact path' });
    if (value !== null && typeof value !== 'string') return void res.status(400).json({ error: 'value must be string or null' });
    const r = setFact(s, p, value === '' ? null : value, 'typed', { sourceText: 'typed in facts panel' });
    if (r.changed) supersedeAttempts(s, [p]);
    const out = settle(s, 'text');
    res.json({ reply: out.reply, state: stateView(s) });
  });

  app.post('/api/sessions/:id/reset', auth, (req, res) => {
    const s = deps.store.resetCase(String(req.params.id));
    res.json({ state: stateView(s!) });
  });

  const download = (res: Response, name: string, type: string, body: string) => {
    res.setHeader('Content-Type', `${type}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(body);
  };
  app.get('/api/sessions/:id/packet.md', auth, (_req, res) => download(res, 'support-packet.md', 'text/markdown', toMarkdown(res.locals.state)));
  app.get('/api/sessions/:id/packet.json', auth, (_req, res) =>
    download(res, 'support-packet.json', 'application/json', JSON.stringify(toJson(res.locals.state), null, 2)),
  );

  app.post('/api/sessions/:id/bind', auth, (req, res) => {
    const callId = req.body?.callId;
    if (typeof callId !== 'string' || !callId || callId.length > 200) return void res.status(400).json({ error: 'callId required' });
    const existing = deps.bindings.get(callId);
    if (existing && existing !== req.params.id) return void res.status(409).json({ error: 'call already bound' });
    deps.bindings.set(callId, String(req.params.id));
    res.json({ bound: true });
  });

  mountVapi(app, deps, lock);

  const here = path.dirname(fileURLToPath(import.meta.url));
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
  app.listen(port, () => console.log(`setup-relay listening on http://localhost:${port}`));
}
