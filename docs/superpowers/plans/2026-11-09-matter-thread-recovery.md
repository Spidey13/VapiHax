# Setup Relay — Implementation Plan (hackathon cut)

> **For agentic workers:** use superpowers:executing-plans (or subagent-driven-development) to run this task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD: write the failing test, see it fail, implement, see it pass, commit.

**Goal:** A browser voice/text companion that guides one failed Matter-over-Thread commissioning case (Home Assistant + Eve Energy fixture), keeps a versioned case state that survives corrections, issues one source-backed next check at a time, and exports a support packet.

**Architecture:** Node 22+ TypeScript service (Express) holding in-memory cases. A code-owned case engine (facts with field versions, attempts, curated checks, dependency stamps) produces every reply from deterministic templates. The same engine is reached from (a) a text endpoint for the browser and (b) an OpenAI-compatible `/vapi/chat/completions` SSE endpoint, which is Vapi's custom-LLM hook. Plain HTML/JS client, no bundler.

**Tech stack:** Node 24 (installed; >=22 required), TypeScript, `tsx`, `express@5`, `vitest`. Phase 2 adds `@vapi-ai/web`. Phase 3 adds `exa-js` and `@typesafe-ai/sdk`.

**Design source:** `docs/superpowers/specs/2026-11-09-matter-thread-recovery-design.md` (approach A, approved by the user 2026-11-09). Evidence IDs (R01, R02, R11, R12) come from `docs/superpowers/research/2026-11-09-matter-thread-evidence.md`.

## Decisions recorded 2026-11-09 (user)

- Approach **A**: failed commissioning → next check + support packet. HA first; synthetic Eve Energy fixture.
- **In:** Vapi (voice + custom-LLM replies), Deepgram via Vapi (Nova-3 + keyterms, Aura TTS), **partial transcripts for latency** (speculative read-only prefetch), Exa live refresh, TypeSafe/Jev correction classifier with a rule-based fallback.
- **Out:** Manus, AdaL, diagnostic imports, user study.
- **Honesty rules carried over:** every screen shows "EXAMPLE CASE — synthetic household", there is never a "fixed" state, the best possible outcome is `user-reported-recovered`, and the demo ends on the packet.

## Phases

| Phase | Outcome | Needs keys? |
|---|---|---|
| **1 — Engine + text UI + custom-LLM endpoint** (below, fully specified) | Whole Journey 2 works by typing; packet downloads; `/vapi/chat/completions` passes contract tests with fake Vapi requests | No |
| **2 — Live voice + partials** (outline) | Vapi web call bound to a case; Deepgram Nova-3 with keyterms; server transcript webhook; stable-partial prefetch; stale-reply guard on emit; latency trace | Vapi |
| **3 — Exa + Jev + demo** (outline) | Live source refresh labeled "live"; Jev interpreter behind the same interface, rule fallback; 60 s demo script + replay mode; rehearsal | Exa, TypeSafe |

---

## File structure (Phase 1)

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example
src/
  case/types.ts        # all record types (Fact, Attempt, Check, CaseState, DependencyStamp, Outcome)
  case/fixture.ts      # synthetic Eve Energy / HA / ZBT-2 seed facts (origin: fixture)
  case/facts.ts        # setFact / proposeFact / conflict handling; field versions + revision
  case/store.ts        # in-memory sessions, epoch, 30-min idle expiry, reset
  rules/checks.ts      # curated checks with sources (R01, R02, R11)
  engine/interpret.ts  # Interpreter interface + RuleInterpreter (assertion/correction/hypothetical/attempt-report)
  engine/select.ts     # next-check eligibility, dedupe, stop-after-two-failed, unsupported
  engine/respond.ts    # deterministic templates + stamp + isStillCurrent()
  engine/turn.ts       # handleTurn(session, text, source) orchestrates the above
  packet.ts            # toMarkdown / toJson
  server.ts            # express app factory (exported for tests) + listen
  vapi/customLlm.ts    # POST /vapi/chat/completions (SSE + non-stream), auth, call binding
public/index.html, public/app.js, public/style.css
test/*.test.ts
```

## Core types (src/case/types.ts), copy as-is

```ts
export type FactStatus = 'candidate' | 'confirmed' | 'disputed' | 'unknown';
export type FactOrigin = 'fixture' | 'user-report' | 'typed';
export interface Fact<T = string> {
  path: string;            // e.g. 'phone.platform'
  value: T | null;         // null = unknown
  version: number;         // monotonic per field, never reused
  status: FactStatus;
  origin: FactOrigin;
  sourceText?: string;     // utterance span that supports it
  updatedAt: number;
}
export type AttemptOutcome = 'not-started' | 'in-progress' | 'succeeded' | 'failed' | 'skipped' | 'unknown';
export interface Attempt {
  id: string; checkId: string; outcome: AttemptOutcome; at: number;
  factSnapshot: Record<string, string | null>;
  applicable: boolean;     // false once a correction makes it no longer apply; never deleted
  note?: string;
}
export interface SourceRef { id: string; url: string; publisher: string; title: string; mode: 'curated' | 'live'; capturedAt: string; }
export interface Check {
  id: string;
  stage: Stage;
  requires: Record<string, string | string[]>; // fact path -> required confirmed value(s)
  dependsOn: string[];                         // fact paths whose version is stamped
  actionText: string;                          // reversible; refer to the source rather than inventing menu paths
  expectedObservation: string;
  stopConditions: string;
  sources: SourceRef[];
  terminal?: 'unsupported';                    // blocker check
}
export type Stage = 'prerequisite' | 'discovery' | 'commissioning' | 'connectivity-check' | 'post-pair-unavailable' | 'unknown';
export type Outcome = 'next-check' | 'user-reported-recovered' | 'unresolved' | 'unsupported' | 'handoff';
export interface DependencyStamp { sessionId: string; epoch: number; fieldVersions: Record<string, number>; checkId?: string; }
export interface Notice { at: number; kind: 'superseded' | 'conflict' | 'clarify' | 'hypothetical'; text: string; }
export interface CaseState {
  sessionId: string; epoch: number; revision: number;
  facts: Record<string, Fact>;
  attempts: Attempt[];
  currentCheck: { check: Check; stamp: DependencyStamp } | null;
  notices: Notice[];
  hypothetical: Record<string, string> | null;  // never merged into facts
  outcome: Outcome;
  lastActivity: number;
}
```

## Fixture (src/case/fixture.ts)

Seed, origin `fixture`, status `confirmed` unless noted:
`accessory.vendor=Eve`, `accessory.product=10EBU4151`, `accessory.model=20EBU4101`, `accessory.region=US/Canada`, `accessory.protocol=matter-thread`, `accessory.firmware=null (unknown)`, `accessory.new=yes`, `controller.platform=home-assistant`, `controller.deployment=HAOS`, `hub.model=ZBT-2`, `hub.threadRole=border-router (reported)`, `topology.otherTbrs=none-reported`, `failure.stage=connectivity-check`. `phone.platform` starts **unknown** (the demo sets it by speech). `phone.googleServices`, `phone.os`, and `sync.status` start unknown.

## Curated checks (src/rules/checks.ts)

Write the action text as short original summaries pointing to the source. Do **not** invent exact menu labels.

| id | stage | requires | outcome |
|---|---|---|---|
| `confirm-border-router` | prerequisite | `controller.platform=home-assistant`, `hub.threadRole` unknown or not confirmed | Ask the user to confirm HA's Thread integration lists the border router [R01, R02] |
| `android-credential-sync` | connectivity-check | `phone.platform=android`, `phone.googleServices=yes`, `sync.status ∈ {unknown, not-done}` | Run the Android Companion "sync Thread credentials" path from the HA Thread docs; expect a success/failure message [R02] |
| `ios-credential-sync` | connectivity-check | `phone.platform=ios`, `sync.status ∈ {unknown, not-done}` | Follow the iPhone credential path from the HA Thread docs [R02] |
| `retry-pairing-once` | commissioning | `sync.status=reported-done`, no failed attempt of this check | One retry in the native commissioning app; report the exact message [R01] |
| `apple-tv-3gen-wifi-only` | prerequisite | `hub.model=apple-tv-4k-3gen-64gb-wifi`, `topology.otherTbrs=none-reported` | terminal `unsupported`; the reported variant has no Thread capability [R11] |

Source URLs: R01 https://www.home-assistant.io/integrations/matter/, R02 https://www.home-assistant.io/integrations/thread/, R11 https://support.apple.com/en-us/111839, R12 https://www.evehome.com/en-us/identify-your-eve-accessory. Use `mode: 'curated'` and `capturedAt: '2026-11-09'`.

If `phone.platform=android` and `phone.googleServices` is unknown, the engine asks the services question instead of issuing the sync check.

---

## Task 0: Repo + toolchain

- [ ] `git init`; `.gitignore`: `node_modules`, `.env`, `dist`, `coverage`.
- [ ] `npm init -y`; set `"type": "module"`, `"engines": {"node": ">=22"}`; scripts `dev: tsx watch src/server.ts`, `start: tsx src/server.ts`, `test: vitest run`, `typecheck: tsc --noEmit`.
- [ ] `npm i express@5` and `npm i -D typescript tsx vitest @types/express @types/node supertest @types/supertest`. Record the exact installed versions in the commit message.
- [ ] tsconfig: `strict`, `module/moduleResolution: NodeNext`, `target ES2022`, `noEmit`.
- [ ] `.env.example`: `PORT=3000`, `VAPI_CUSTOM_LLM_SECRET=`, `VAPI_PUBLIC_KEY=`, `VAPI_ASSISTANT_ID=`, `EXA_API_KEY=`, `TYPESAFE_API_KEY=` (values empty).
- [ ] Trivial passing test; `npm test` and `npm run typecheck` are green. Commit `chore: scaffold`.

## Task 1: Types, fixture, facts with versions

Tests (`test/facts.test.ts`):
- [ ] Fixture loads; `accessory.firmware.value === null` and its status is `unknown`.
- [ ] `setFact(state,'phone.platform','ios','user-report')` → version 1, revision +1. Then `android` → version 2. Then `ios` again → version **3** (monotonic, no resurrection).
- [ ] A typed confirmed value contradicted by a voice report → status `disputed`, a `conflict` notice is added, and the value is unchanged until `resolveConflict`.
- [ ] Implement `src/case/types.ts`, `fixture.ts`, `facts.ts`. Commit.

## Task 2: Store

- [ ] Tests: two sessions are isolated; `reset` increments `epoch` and reseeds the fixture; a stamp from the old epoch is not current; idle >30 min → `get` returns undefined (inject a clock).
- [ ] Implement `store.ts` with `createCase()`, `getCase(id)`, `resetCase(id)`, and `now` injectable. Commit.

## Task 3: Rule interpreter

`interface Interpreter { interpret(text: string, state: CaseState): Promise<Interpretation> }`
`Interpretation = { kind: 'assertion'|'correction'|'hypothetical'|'attempt-report'|'unknown'; facts?: Record<string,string>; attempt?: {checkId?: string; outcome: AttemptOutcome}; confidence: 'rule' }`

Tests (`test/interpret.test.ts`), table-driven:
- [ ] "I'm pairing on my iPhone" → assertion `phone.platform=ios`
- [ ] "Actually I'm using my Android tablet" → correction `phone.platform=android`
- [ ] "Would using an Android tablet help?" → hypothetical (no facts)
- [ ] "Actually not the tablet, back to the iPhone" → correction `ios`
- [ ] "I already tried that and it failed" → attempt-report `failed` (against the current check)
- [ ] "I haven't done that" → attempt-report `not-started`; "it worked" / "it paired" → `succeeded`
- [ ] "yes it has Google Play services" → assertion `phone.googleServices=yes`
- [ ] "sync said success" → `sync.status=reported-done`; "sync failed" → `sync.status=failed`
- [ ] "My hub is an Apple TV 4K third gen, the 64 gig wifi one" → `hub.model=apple-tv-4k-3gen-64gb-wifi`
- [ ] "Eve plug" alone → no `accessory.product` change (identifiers come only from exact matches)
- [ ] Implement keyword/regex rules in `RuleInterpreter`. Commit.

## Task 4: Next-check selection

Tests (`test/select.test.ts`):
- [ ] Fixture + `phone.platform=android`, googleServices unknown → a clarify question about Google services, no check.
- [ ] + googleServices=yes → `android-credential-sync`, with a stamp containing the versions of `phone.platform` and `phone.googleServices`.
- [ ] `phone.platform=ios` → `ios-credential-sync`; the Android check is never eligible.
- [ ] A check with a failed applicable attempt is not reissued.
- [ ] Two distinct failed checks → outcome `handoff`, no check.
- [ ] The Apple TV blocker → outcome `unsupported`, with no reset or shopping text.
- [ ] Unknown firmware does not block these checks (they are version-independent).
- [ ] Implement `select.ts`. Commit.

## Task 5: Turn handling, corrections, stale guard

`handleTurn(state, text, source:'text'|'voice', interpreter) → { reply: string; stamp: DependencyStamp | null; state }`
`isStillCurrent(state, stamp)`: same epoch, and every stamped field version equals the current one.

Tests (`test/turn.test.ts`), Journey 2 end to end:
- [ ] "my Eve Energy won't pair, I'm on my iPhone" → reply issues `ios-credential-sync`.
- [ ] "Actually I'm using my Android tablet" → `phone.platform` version bumps; the old iPhone check is superseded (a notice says "the iPhone step no longer applies"); any iPhone attempts get `applicable=false` but stay in the list; accessory facts are unchanged; reply asks about Google services (it does **not** assume they exist).
- [ ] "yes, Google services" → `android-credential-sync`.
- [ ] Stale guard: take the stamp from the iPhone reply, apply the correction, then `isStillCurrent(oldStamp)` is false.
- [ ] Hypothetical "would an Android tablet help?" when the platform is ios → facts unchanged, `hypothetical` set, a hypothetical notice is added, and the reply answers without switching branches.
- [ ] "I already tried that and it failed" → failed attempt recorded against the current check; the next reply does not repeat it.
- [ ] "sync said success" then "it still failed" after `retry-pairing-once` → outcome `unresolved` with handoff text.
- [ ] "it paired and the plug turns on" → `user-reported-recovered` (never "fixed").
- [ ] Implement `respond.ts` (short templates, max 2 sentences spoken, each check reply includes `expectedObservation`) and `turn.ts`. Commit.

## Task 6: Packet

- [ ] Tests: Markdown starts with `**EXAMPLE CASE — synthetic household; not a recovered real device**`; lists identity with firmware "unknown"; attempts with outcomes, including superseded ones marked "no longer applicable"; next action or stop reason; source URLs with "curated 2026-11-09"; the outcome. It never contains "fixed" or "network healthy". JSON has the same fields.
- [ ] Implement `packet.ts`. Commit.

## Task 7: HTTP API

`createApp(deps)` exported from `server.ts`; `listen` only when run directly.
- [ ] `POST /api/sessions` → `{sessionId, token}` (random 32-byte hex token; required as `Authorization: Bearer` on the routes below)
- [ ] `GET /api/sessions/:id` → state view (facts, currentCheck, attempts, notices, outcome, revision)
- [ ] `POST /api/sessions/:id/turn {text}` → `{reply, state}`
- [ ] `PATCH /api/sessions/:id/facts {path, value}` → typed, confirmed edit
- [ ] `POST /api/sessions/:id/reset`
- [ ] `GET /api/sessions/:id/packet.md` and `/packet.json` (download headers)
- [ ] `POST /api/sessions/:id/bind {callId}` → binds a Vapi call id to this session (Phase 2 uses it)
- [ ] supertest tests: wrong token → 401; unknown session → 404; Journey 2 via HTTP. Commit.

## Task 8: Vapi custom-LLM endpoint (contract-tested, no live Vapi yet)

`POST /vapi/chat/completions`. The live envelope gets verified in Phase 2, so parse defensively:
- [ ] Auth: require `Authorization: Bearer ${VAPI_CUSTOM_LLM_SECRET}` **or** header `x-vapi-secret`; if the secret is unset → 503. Never accept an unauthenticated request.
- [ ] Session: `body.call.id` → binding map → session. No binding → reply "This call isn't linked to a case yet." **Never** fall back to the "latest session" or to transcript similarity.
- [ ] Input: the last `messages[]` entry with `role:'user'`. Ignore assistant/system messages as facts.
- [ ] Before writing, run `handleTurn(..., 'voice', ...)`, then check `isStillCurrent` immediately before emitting. If it's stale, recompute once.
- [ ] `stream:true` → `text/event-stream`, write `data: {"id","object":"chat.completion.chunk","created","model":"setup-relay","choices":[{"index":0,"delta":{"role":"assistant","content":"..."},"finish_reason":null}]}` per sentence, then a final chunk with `finish_reason:"stop"`, then `data: [DONE]`. `stream:false` → a `chat.completion` JSON object.
- [ ] Log one trace line per request: `{sessionId, callId, revision, msReceivedToFirstByte}`. No transcript text in logs.
- [ ] Tests: bad secret → 401; unbound call → the safe message; bound call + "I'm on my Android tablet" → SSE ends with `[DONE]` and the case state updated; non-stream shape. Commit.

## Task 9: Browser UI (text mode)

`public/index.html` + `app.js` (vanilla, ES modules), served statically by Express.
- [ ] A persistent banner: "EXAMPLE CASE — synthetic household".
- [ ] Start case button; text input + send; reply area.
- [ ] Editable facts panel (unknown shown as "unknown", disputed highlighted); edits use the PATCH route.
- [ ] "Current check" card: action, expected observation, source links, and quick buttons "Done – worked" / "Done – failed" / "Haven't done it" (these post as turns).
- [ ] An attempt timeline including superseded attempts (struck through, labeled "no longer applies").
- [ ] A notices strip (superseded / hypothetical / conflict).
- [ ] Download packet (.md / .json) and Reset buttons.
- [ ] Mobile-friendly single column; keep it simple.
- [ ] Manual check: `npm start`, open http://localhost:3000, run Journey 2 by typing. Commit.

## Task 10: Phase 1 exit

- [ ] `npm test` and `npm run typecheck` are green; paste the summary into the report.
- [ ] Write a `README.md` with run steps, what's live vs fixture, and the Phase 2/3 TODO list.
- [ ] Commit `docs: phase 1 complete`. Stop and report. **Do not start Phase 2.**

---

## Phase 2 outline: live voice + partials (detailed after Phase 1)

1. **Vapi assistant config (server-side, never from the browser):** model provider `custom-llm` → `${PUBLIC_URL}/vapi` with the secret; transcriber Deepgram `nova-3` with **keyterms** (`ZBT-2`, `Eve Energy`, `Home Assistant`, `Thread`, `Matter`, `Companion`, `border router`, `iPhone`, `Android`); voice Deepgram Aura-2; tight endpointing (start-speaking plan tuned for short turns). Server URL subscribed to `transcript` (partial + final), `speech-update`, `user-interrupted`, `status-update`, `end-of-call-report`.
2. **Browser:** `@vapi-ai/web` via CDN ESM; start the call on a user gesture with `assistantId` + `metadata.sessionId`; after `call-start`, POST `/bind {callId}`. Captions come from client `message` events and are display-only.
3. **Webhook `/vapi/events`:** authenticated; resolve the session by `call.id`. **Partials:** a candidate span stable across two consecutive partials → start **read-only, quarantined** prefetch (rule eligibility now; Exa lookup in Phase 3) keyed by the hypothesis. Facts change only on final input or a custom-LLM turn. `user-interrupted` → invalidate queued reply units.
4. **Latency trace:** per utterance, record `firstPartialAt`, `stablePartialAt`, `prefetchDoneAt`, `finalAt`, `llmRequestAt`, `firstByteAt`. Show them in a reviewer view. No published latency claims until measured.
5. **Tunnel:** HTTPS with SSE support (cloudflared or ngrok); verify the real `/chat/completions` path Vapi calls.
6. Probe gate (first 15 min): if the custom-LLM binding or replies fail → text input + spoken output fallback, labeled on screen.

## Phase 3 outline: Exa + Jev + demo

1. **Exa:** `exa-js` `searchAndContents` with `includeDomains` (home-assistant.io, evehome.com, support.apple.com), `maxAgeHours` for freshness; results become `SourceRef{mode:'live'}` cards that **support** curated checks. They never create new checks. Abstain on scope mismatch, 401, 429, or timeout.
2. **Jev:** `JevInterpreter implements Interpreter` via `@typesafe-ai/sdk` (Node 22+). Batch questions: replacing current phone? / asking about a different phone? / reports result of check X? Noul bands >0.7 / <0.3; both-yes or an error → clarify; timeout → RuleInterpreter fallback. Re-read the official skill before coding.
3. **Demo:** a 60 s script (iPhone → Android correction → Google-services confirm → Android check → "already tried, failed" → packet). A replay mode for when the network fails, labeled "replay". Rehearse twice.
