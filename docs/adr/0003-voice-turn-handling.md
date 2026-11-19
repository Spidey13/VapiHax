# 0003 · Reconcile voice turns against playback evidence

**Status** Implemented

## Context

Speech may continue after endpointing, and a user can interrupt an answer while Vapi is still synthesizing it. The model stream, the text emitted to Vapi and the audio that reached the caller can be at different positions.

## Decision

Use Vapi’s custom LLM and events callbacks with an explicit authenticated browser call binding. Stream complete sentences as SSE and append Vapi’s flush marker at the transport boundary. Track what was emitted separately from speech and playback events.

Hold and session mutations are enforced on the server. Serialize commits per session, scope cancellation to the in-flight response, and use request transcript and playback evidence to reconcile overlapping utterances. Where the evidence warrants it, trim the stored reply to the spoken prefix or roll back the latest unseen turn so extended speech can be processed together. The browser captions also advance on playback evidence. Ignore empty turns and keep ended sessions read-only.

## Consequences

A short reply or acknowledgement can be sent to speech synthesis as soon as it is ready. Actual playback still depends on the provider, and delayed or missing events can limit how precisely the app can reconcile a turn. Offline tests cover framing, interrupted replies, overlapping requests and captions. A real call is needed to evaluate microphone-to-speaker timing.

[Assistant configuration](../../src/vapi/assistantConfig.ts) · [Custom LLM adapter](../../src/vapi/customLlm.ts) · [Spoken event log](../../src/vapi/spoken.ts) · [Overlap tests](../../test/overlap.test.ts) · [Vapi speech configuration](https://docs.vapi.ai/customization/speech-configuration)
