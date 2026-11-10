import { describe, it, expect } from 'vitest';
import { buildAssistantPayload, updateEnvText, parseTunnelUrl } from '../src/vapi/assistantConfig.js';

describe('assistant payload', () => {
  const p = buildAssistantPayload({ publicUrl: 'https://x-y.trycloudflare.com/', secret: 'S' });
  it('wires custom-llm, events and nova-3 keyterms', () => {
    expect(p.model.url).toBe('https://x-y.trycloudflare.com/vapi');
    expect(p.server.url).toBe('https://x-y.trycloudflare.com/vapi/events');
    expect(p.transcriber.model).toBe('nova-3');
    expect(p.transcriber.keyterm).toContain('Eve Energy');
    expect(p.serverMessages).toContain('transcript');
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
