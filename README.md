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
