# Setup Relay (Phase 1)

A text/voice companion that guides one failed Matter-over-Thread commissioning case (Home Assistant + Eve Energy, **synthetic fixture**), keeps versioned case state that survives corrections, issues one source-backed check at a time, and exports a support packet. Every screen shows **EXAMPLE CASE — synthetic household**. There is no "fixed" state; the best outcome is `user-reported-recovered`.

## Run

```
npm install
npm start            # http://localhost:3000  (PORT from env or .env)
npm test
npm run typecheck
```

Copy `.env.example` to `.env` for local settings (git-ignored; the server loads it on start). Only `VAPI_CUSTOM_LLM_SECRET` matters in Phase 1.

Try Journey 2 by typing: "my Eve Energy won't pair, I'm on my iPhone" → "Actually I'm using my Android tablet" → "yes, Google services" → "I tried that and it failed" → download the packet.

## What is live vs fixture

- **Live:** case engine, versioned facts, rule-based interpreter, check selection, stale-reply guard, packet export, HTTP API, `/vapi/chat/completions` (contract-tested with fake Vapi requests).
- **Fixture:** the household, accessory, hub and controller facts. Sources are curated captures (2026-11-09), not live lookups.
- **Not built:** voice, Vapi web call, Deepgram, Exa, TypeSafe/Jev.

## API

All `/api/sessions/:id/*` routes need `Authorization: Bearer <token>` from `POST /api/sessions`.
`GET /` state, `POST /turn {text}`, `PATCH /facts {path,value}`, `POST /reset`, `GET /packet.md|.json`, `POST /bind {callId}`.

`POST /vapi/chat/completions` needs `Authorization: Bearer $VAPI_CUSTOM_LLM_SECRET` or `x-vapi-secret` (503 if unset). The session is found only through `body.call.id` previously bound via `/bind`; unbound calls get a safe message.

## Phase 2 / 3 TODO

- Phase 2: Vapi assistant config (custom-llm → `${PUBLIC_URL}/vapi`), `@vapi-ai/web` call + `/bind`, `/vapi/events` webhook, stable-partial read-only prefetch, latency trace, HTTPS tunnel, verify the real request envelope.
- Phase 3: Exa live refresh (labeled "live"), Jev interpreter with rule fallback, 60 s demo script + replay mode.

## Live voice mode (Phase 2)

```
npm run live      # starts the server + a cloudflared quick tunnel, writes PUBLIC_URL, creates/updates the Vapi assistant
npm run vapi:sync # re-sync the assistant only (needs PUBLIC_URL set)
```

`.env` needs `VAPI_PRIVATE_KEY`, `VAPI_PUBLIC_KEY`, `VAPI_CUSTOM_LLM_SECRET`, `DEEPGRAM_API_KEY` (registered as a Vapi Deepgram credential, idempotently). The sync script edits only the `VAPI_ASSISTANT_ID=` and `PUBLIC_URL=` lines. Verified Vapi fields: `docs/superpowers/research/vapi-verified.md`.

Human mic test:
1. `npm run live`, wait for "Tunnel: https://….trycloudflare.com" and "assistant updated/created".
2. Open http://localhost:3000, click **Start case**, then **Start voice**; allow the microphone. Don't read setup codes aloud.
3. Wait for "live — talk now" (the call is bound to your case by call id before the mic opens).
4. Say: "My Eve Energy won't pair, I'm on my iPhone." Expect a spoken next check, captions (grey = partial), and the Current check card updating.
5. Say: "Actually I'm using my Android tablet." Expect "The iPhone step no longer applies" and a Google Play services question.
6. Interrupt the assistant mid-sentence once; it should stop. Open "Reviewer" for the latency trace (firstPartial → stable → prefetchDone → final → llmReq → firstByte).
7. Ctrl+C stops the server and the tunnel. The tunnel URL changes every run (the next `npm run live` re-syncs the assistant).
8. If voice fails, tick "Text + spoken reply" (browser speechSynthesis, not Vapi).
