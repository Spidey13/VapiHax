/**
 * Turn-taking. A punctuated final transcript is the common case: its wait went straight onto every reply (the
 * request reached the server 0.5-0.65 s after the user's last final transcript), so it is short; an unpunctuated
 * one still waits long enough for a thinking pause.
 */
export const ENDPOINTING = { waitSeconds: 0.4, onPunctuationSeconds: 0.8, onNoPunctuationSeconds: 1.5, onNumberSeconds: 1.0 } as const;
/*
 * Deepgram's own pause before a final transcript stays at Vapi's default. Raising it to 300 ms (to keep one-word
 * utterances whole) added about 0.9 s of transcriber latency per turn in a measured call (2026-11-16: 1.28 s -> 2.15 s
 * average); a turn split by a short pause is joined on the server instead (src/vapi/reconcile.ts).
 */
/**
 * Words the speech model should favour (nova-3 `keyterm`). The demo's place names are here; for general use, replace
 * this list with the vocabulary of the current session (branch titles, names the user has said) when the call starts.
 * Keep it on (`VAPI_KEYTERMS` unset). A/B on 2026-11-17, live call 1: with keyterms off the phantom tail ("Kyoto 3"
 * after a finished utterance) still appeared at the same ~4.27 s delay as in the two runs with keyterms on, so keyterms
 * are not its cause (see phantomTail in customLlm.ts); and with them off the transcripts read "Naseko", "Forano",
 * "Ferrano" for Niseko and Furano.
 */
export const KEYTERMS = ['Hokkaido', 'Furano', 'Niseko', 'Kyoto', 'ryokan', 'onsen', 'Branch Voice'] as const;
/** Krisp background-speech/noise filtering on the user's audio, so a noisy room or a second voice does not interrupt or garble. */
export const DENOISING = { smartDenoisingPlan: { enabled: true } } as const;
/**
 * Vapi's default chunk plan holds text until 30 characters, so a short filler or "Back to X." was only spoken
 * together with the real reply. The server streams whole sentences, so a sentence end is the only boundary needed.
 */
export const CHUNK_MIN_CHARACTERS = 5;
export const CHUNK_PLAN = { enabled: true, minCharacters: CHUNK_MIN_CHARACTERS, punctuationBoundaries: ['.', '!', '?'] } as const;
/**
 * Interrupt on two transcribed words, or at once on an interruption phrase (Vapi: these always interrupt, whatever
 * numWords is), so "Wait", "Sorry", "No", "Actually", "Back" still stop the assistant immediately. numWords 0 (voice
 * activity) let leg movement and the one-word phantom partials of the caller's own last word (2026-11-17 take: "Niseko",
 * "Furano," ~4 s after the caller spoke) cut replies mid-sentence. voiceSeconds only applies at numWords 0; raised to
 * 0.5 as a backstop. A short backoff lets the new turn start quickly. The phrases are Vapi's default interruption list
 * plus words this app's users say to cut in (a custom list replaces the defaults, so they are repeated);
 * acknowledgement phrases (okay, yeah) keep their default and never interrupt.
 */export const STOP_SPEAKING = {
  numWords: 2,
  voiceSeconds: 0.5,
  backoffSeconds: 0.4,
  interruptionPhrases: [
    'stop', 'shut', 'up', 'enough', 'quiet', 'silence', 'but', 'dont', 'not', 'no', 'hold', 'wait', 'cut', 'pause',
    'nope', 'nah', 'nevermind', 'never', 'bad', 'actually', 'sorry', 'back', 'remind',
  ],
} as const;

/** Pure builder for the Vapi assistant payload. An empty keyterms list omits `transcriber.keyterm`. See docs/adr/0003-voice-turn-handling.md. */
export function buildAssistantPayload(opts: { publicUrl: string; secret: string; credentialIds?: string[]; keyterms?: readonly string[] }) {
  const base = opts.publicUrl.replace(/\/+$/, '');
  const headers = { 'x-vapi-secret': opts.secret };
  return {
    name: 'Branch Voice',
    ...(opts.credentialIds?.length ? { credentialIds: opts.credentialIds } : {}),
    firstMessage: "Hi. What are you thinking about?",
    model: {
      provider: 'custom-llm',
      // Vapi uses this as the OpenAI client baseURL and appends /chat/completions.
      url: `${base}/vapi`,
      model: 'branch-voice',
      headers,
      // `off` strips call.id, so even an explicitly bound call cannot resolve its session.
      metadataSendMode: 'variable',
      timeoutSeconds: 20,
    },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en', ...((opts.keyterms ?? KEYTERMS).length ? { keyterm: [...(opts.keyterms ?? KEYTERMS)] } : {}) },
    backgroundSpeechDenoisingPlan: { smartDenoisingPlan: { enabled: DENOISING.smartDenoisingPlan.enabled } },
    voice: { provider: 'deepgram', model: 'aura-2', voiceId: 'thalia', chunkPlan: { ...CHUNK_PLAN, punctuationBoundaries: [...CHUNK_PLAN.punctuationBoundaries] } },
    server: { url: `${base}/vapi/events`, headers, timeoutSeconds: 10 },
    serverMessages: ['transcript', 'speech-update', 'user-interrupted', 'status-update', 'end-of-call-report', 'assistant.speechStarted'],
    clientMessages: ['transcript', 'speech-update', 'status-update', 'user-interrupted', 'assistant.speechStarted'],
    startSpeakingPlan: {
      waitSeconds: ENDPOINTING.waitSeconds,
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: ENDPOINTING.onPunctuationSeconds,
        onNoPunctuationSeconds: ENDPOINTING.onNoPunctuationSeconds,
        onNumberSeconds: ENDPOINTING.onNumberSeconds,
      },
    },
    stopSpeakingPlan: {
      numWords: STOP_SPEAKING.numWords,
      voiceSeconds: STOP_SPEAKING.voiceSeconds,
      backoffSeconds: STOP_SPEAKING.backoffSeconds,
      interruptionPhrases: [...STOP_SPEAKING.interruptionPhrases],
    },
  };
}

/** Replace (or append) KEY=value lines in .env text, touching only the allowed keys. */
export function updateEnvText(text: string, updates: Record<string, string>): string {
  const allowed = new Set(['VAPI_ASSISTANT_ID', 'PUBLIC_URL']);
  let out = text;
  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.has(k)) throw new Error(`refusing to edit ${k}`);
    const re = new RegExp(`^${k}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, () => `${k}=${v}`) : out + (out.endsWith('\n') ? '' : '\n') + `${k}=${v}\n`;
  }
  return out;
}

export function parseTunnelUrl(line: string): string | null {
  return line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
}
