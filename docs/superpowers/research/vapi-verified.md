# Vapi fields verified 2026-11-09 (docs.vapi.ai .md pages + @vapi-ai/web@3.1.0 typings)

- Create/Update: `POST https://api.vapi.ai/assistant`, `PATCH /assistant/{id}`, `Authorization: Bearer <private key>`.
- `model`: `{provider:'custom-llm', url (OpenAI baseURL; server gets /chat/completions), model, headers (map; Authorization must come from a credential, so we use x-vapi-secret), metadataSendMode, timeoutSeconds}`.
- `transcriber`: `{provider:'deepgram', model:'nova-3', language:'en', keyterm:[...]}` (Nova-3 uses `keyterm`, not `keywords`).
- `voice`: `{provider:'deepgram', model:'aura-2', voiceId:'thalia'}` (voiceId is an enum; thalia is listed in the docs' Aura set).
- `server`: `{url, headers, timeoutSeconds, credentialId?}`; `serverMessages` / `clientMessages` string arrays (transcript, speech-update, user-interrupted, status-update, end-of-call-report all valid).
- `startSpeakingPlan`: `waitSeconds`, `transcriptionEndpointingPlan{onPunctuationSeconds,onNoPunctuationSeconds,onNumberSeconds}`, `smartEndpointingPlan`.
- Server event body: `{message:{type, call:{id}, ...}}`; transcript: `{type:'transcript', role, transcriptType:'partial'|'final', transcript}`; may also arrive as `type:'transcript[transcriptType="final"]'`. speech-update: `{status:'started'|'stopped', role, turn}`.
- Web SDK 3.1.0: `start(assistant: string|object, overrides?) : Promise<Call|null>`; `call.id` is the call id. Events: `call-start`, `message`, `speech-start/end`, `error`.
- NOT verified from docs (verify live): the exact custom-LLM request body (is `call` included?). The server logs the body keys of the first request.
