import { describe, it, expect } from 'vitest';
import { buildAssistantPayload, updateEnvText, parseTunnelUrl } from '../src/vapi/assistantConfig.js';
import { FILLERS } from '../src/reply/filler.js';

describe('assistant payload', () => {
  const p = buildAssistantPayload({ publicUrl: 'https://x-y.trycloudflare.com/', secret: 'S' });
  it('is named and greets for Branch Voice', () => {
    expect(p.name).toBe('Branch Voice');
    expect(p.firstMessage).toBe('Hi. What are you thinking about?');
  });
  it('wires custom-llm and events', () => {
    expect(p.model.url).toBe('https://x-y.trycloudflare.com/vapi');
    expect(p.model.headers).toEqual({ 'x-vapi-secret': 'S' });
    expect(p.server.url).toBe('https://x-y.trycloudflare.com/vapi/events');
    expect(p.transcriber.model).toBe('nova-3');
    expect('keyterm' in buildAssistantPayload({ publicUrl: 'https://x.test', secret: 'S', keyterms: [] }).transcriber).toBe(false);
    expect(p.serverMessages).toContain('transcript');
  });
  it('asks for playback progress on both channels without dropping transcripts or speech updates', () => {
    for (const list of [p.serverMessages, p.clientMessages]) {
      expect(list).toEqual(expect.arrayContaining(['transcript', 'speech-update', 'user-interrupted', 'status-update', 'assistant.speechStarted']));
    }
  });
  it('includes call metadata so the custom LLM can resolve the browser binding', () => {
    expect(p.model.metadataSendMode).toBe('variable');
  });
  it('tunes turn-taking for thinking pauses', () => {
    expect(p.startSpeakingPlan).toEqual({
      waitSeconds: 0.4,
      transcriptionEndpointingPlan: { onPunctuationSeconds: 0.8, onNoPunctuationSeconds: 1.5, onNumberSeconds: 1.0 },
    });
  });
  it('stops on clear voice, not on a word count, and keeps the backoff short', () => {
    const s = p.stopSpeakingPlan;
    expect(s.numWords).toBe(2);
    expect(s.voiceSeconds).toBe(0.5);
    expect(s.backoffSeconds).toBeLessThanOrEqual(0.5);
    expect(s.interruptionPhrases).toEqual(expect.arrayContaining(['sorry', 'wait', 'actually', 'stop', 'no']));
    expect('acknowledgementPhrases' in s).toBe(false);
  });
  it('filters noise and biases the transcriber to the demo vocabulary', () => {
    expect(p.backgroundSpeechDenoisingPlan).toEqual({ smartDenoisingPlan: { enabled: true } });
    expect('endpointing' in p.transcriber).toBe(false); // Vapi's default: 300 ms added ~0.9 s per turn
    expect(p.transcriber.keyterm).toEqual(expect.arrayContaining(['Furano', 'Niseko', 'Hokkaido', 'ryokan']));
    expect(p.transcriber.model).toBe('nova-3');
    expect('keyterm' in buildAssistantPayload({ publicUrl: 'https://x.test', secret: 'S', keyterms: [] }).transcriber).toBe(false);
  });
  it('lets Vapi speak a short filler or "Back to X." as soon as it arrives', () => {
    expect(p.voice.chunkPlan).toEqual({ enabled: true, minCharacters: 5, punctuationBoundaries: ['.', '!', '?'] });
    for (const f of FILLERS) {
      expect(f.length).toBeGreaterThanOrEqual(p.voice.chunkPlan.minCharacters);
      expect(p.voice.chunkPlan.punctuationBoundaries).toContain(f.at(-1));
    }
  });
  it('env edits only allowed keys', () => {
    expect(updateEnvText('A=1\nPUBLIC_URL=\n', { PUBLIC_URL: 'u' })).toBe('A=1\nPUBLIC_URL=u\n');
    expect(() => updateEnvText('', { VAPI_PRIVATE_KEY: 'x' })).toThrow();
  });
  it('parses tunnel url', () => {
    expect(parseTunnelUrl('|  https://abc-def.trycloudflare.com  |')).toBe('https://abc-def.trycloudflare.com');
    expect(parseTunnelUrl('nothing')).toBeNull();
  });
});
