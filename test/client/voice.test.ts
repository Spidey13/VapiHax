import { describe, it, expect, vi } from 'vitest';
import { createVoice } from '../../public/js/voice.js';

function setup() {
  const inst: any = { on: vi.fn(), stop: vi.fn(), setMuted: vi.fn(), send: vi.fn(), start: vi.fn() };
  let release: (v: any) => void = () => {};
  const gates = { load: null as null | (() => void) };
  const loadVapi = () => new Promise((res) => { gates.load = () => res(function () { return inst; }); });
  const api = vi.fn(async () => ({}));
  const refresh = vi.fn(async () => {});
  const voice = createVoice({
    api, sessionId: () => 's', arc: { reset() {}, start() {}, setWait() {} } as any, isHeld: () => false,
    setSpeaking() {}, refresh, onCaption() {}, onStatus() {}, loadVapi,
  } as any);
  return { inst, gates, api, voice, setRelease: (r: any) => { release = r; }, release: (v: any) => release(v) };
}
const cfg = { vapiPublicKey: 'k', assistantId: 'a' };

describe('voice stop vs start', () => {
  it('stop during the library load: nothing is created or bound', async () => {
    const t = setup();
    const p = t.voice.start(cfg);
    t.voice.stop();
    t.gates.load!();
    expect(await p).toBe(false);
    expect(t.inst.start).not.toHaveBeenCalled();
    expect(t.api).not.toHaveBeenCalled();
    expect(t.voice.isLive()).toBe(false);
  });
  it('stop while inst.start is pending: instance stopped, never bound', async () => {
    const t = setup();
    let resolveStart: (c: any) => void = () => {};
    t.inst.start.mockImplementation(() => new Promise((r) => { resolveStart = r; }));
    const p = t.voice.start(cfg);
    t.gates.load!();
    await vi.waitFor(() => expect(t.inst.start).toHaveBeenCalled());
    t.voice.stop();
    resolveStart({ id: 'c1' });
    expect(await p).toBe(false);
    expect(t.inst.stop).toHaveBeenCalled();
    expect(t.api).not.toHaveBeenCalled();
    expect(t.voice.isLive()).toBe(false);
  });
  it('stop while binding: instance stopped and no poll timer left', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.inst.start.mockResolvedValue({ id: 'c1' });
    let resolveBind: () => void = () => {};
    t.api.mockImplementation(() => new Promise((r: any) => { resolveBind = r; }));
    const p = t.voice.start(cfg);
    t.gates.load!();
    await vi.waitFor(() => expect(t.api).toHaveBeenCalled());
    t.voice.stop();
    resolveBind();
    expect(await p).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it('a normal start still connects and binds', async () => {
    const t = setup();
    t.inst.start.mockResolvedValue({ id: 'c1' });
    const p = t.voice.start(cfg);
    t.gates.load!();
    expect(await p).toBe(true);
    expect(t.api).toHaveBeenCalled();
    expect(t.voice.isLive()).toBe(true);
    t.voice.stop();
  });
});

describe('vapiClass', () => {
  it('finds the constructor however the CDN wraps the module', async () => {
    const { vapiClass } = await import('../../public/js/voice.js');
    class Vapi {}
    expect(vapiClass({ default: Vapi })).toBe(Vapi);
    expect(vapiClass({ __esModule: true, default: { default: Vapi } })).toBe(Vapi);
    expect(() => vapiClass({ default: {} })).toThrow(/no constructor/);
  });
});

describe('raw playback messages', () => {
  it('assistant.speechStarted reaches onEvent untouched', async () => {
    const inst: any = { on: vi.fn(), stop: vi.fn(), setMuted: vi.fn(), send: vi.fn(), start: vi.fn().mockResolvedValue({ id: 'c1' }) };
    const onEvent = vi.fn();
    const voice = createVoice({
      api: vi.fn(async () => ({})), sessionId: () => 's', arc: { reset() {}, start() {}, setWait() {} } as any, isHeld: () => false,
      setSpeaking() {}, refresh: vi.fn(async () => {}), onCaption() {}, onStatus() {}, onEvent, loadVapi: async () => function () { return inst; },
    } as any);
    expect(await voice.start(cfg)).toBe(true);
    const handler = inst.on.mock.calls.find((c: any[]) => c[0] === 'message')[1];
    const m = { type: 'assistant.speechStarted', text: 'Sure thing.', turn: 1, source: 'model' };
    handler(m);
    expect(onEvent).toHaveBeenCalledWith(m);
    voice.stop();
  });
});
