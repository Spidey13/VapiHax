# Measure voice latency

The [router report](router-eval.md) gives timing for cached, labelled routing examples. Branch Voice has no published aggregate end-to-end voice latency benchmark for this checkout.

## Collect local traces

1. Start [voice mode](../setup.md#choose-an-input-mode) and open `/?debug=1` on the printed localhost origin.
2. Run a few fresh voice sessions with a mix of continuations, forks, corrections and interruptions. At the end of each, copy the footer command before closing the server. Its session token is a bearer credential.
3. Run `npm run latency -- <session-id> <token>`. The command accepts up to three ID/token pairs and reports p50, p90 and sample counts alongside speculation, filler and fallback rates.
4. Record the model, voice configuration and sample counts with any results. Keep raw session traces and tokens out of shared reports.

## Interpret the clocks

- The CLI uses the server’s final transcript timestamp, falling back to custom LLM request receipt when that event is missing. This is a server-side proxy for the end of speech.
- First SSE chunk and first complete sentence are emission milestones. The first sentence excludes filler. The CLI row labelled “first audio” uses the earliest filler or sentence emission and is a text emission proxy.
- `playbackStartedAt` records when a playback-start event reaches the server, when available. It includes provider event delivery time. A synchronized audio capture is needed for microphone-to-audible-response timing.
- `npm run ttft` runs a billed model-only experiment on a fixed prompt. It measures time to first text delta and writes a local report under `docs/results/generated/`.

[Trace fields](../../src/trace.ts) · [Stage calculations](../../src/latencyStats.ts) · [Latency CLI](../../scripts/latency.ts)
