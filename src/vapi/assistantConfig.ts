/** Pure builder for the Vapi assistant payload. Field names verified against docs.vapi.ai (see docs/superpowers/research/vapi-verified.md). */
export const KEYTERMS = [
  'ZBT-2', 'Eve Energy', 'Home Assistant', 'Thread', 'Matter', 'Companion',
  'border router', 'iPhone', 'Android', 'Google Play services',
];

export function buildAssistantPayload(opts: { publicUrl: string; secret: string }) {
  const base = opts.publicUrl.replace(/\/+$/, '');
  const headers = { 'x-vapi-secret': opts.secret };
  return {
    name: 'Setup Relay',
    firstMessage: "Setup Relay here. This is an example case. What's happening with your device?",
    model: {
      provider: 'custom-llm',
      // Vapi uses this as the OpenAI client baseURL and appends /chat/completions.
      url: `${base}/vapi`,
      model: 'setup-relay',
      headers,
      metadataSendMode: 'off',
      timeoutSeconds: 20,
    },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en', keyterm: KEYTERMS },
    voice: { provider: 'deepgram', model: 'aura-2', voiceId: 'thalia' },
    server: { url: `${base}/vapi/events`, headers, timeoutSeconds: 10 },
    serverMessages: ['transcript', 'speech-update', 'user-interrupted', 'status-update', 'end-of-call-report'],
    clientMessages: ['transcript', 'speech-update', 'status-update', 'user-interrupted'],
    startSpeakingPlan: {
      waitSeconds: 0.3,
      transcriptionEndpointingPlan: { onPunctuationSeconds: 0.1, onNoPunctuationSeconds: 1.0, onNumberSeconds: 0.5 },
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
