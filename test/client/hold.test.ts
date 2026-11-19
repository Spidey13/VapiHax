import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHold } from '../../public/js/hold.js';

type Handler = (e: any) => void;
function target() {
  const h = new Map<string, Handler[]>();
  return {
    addEventListener: (t: string, f: Handler) => h.set(t, [...(h.get(t) ?? []), f]),
    fire: (t: string, e: any = {}) => (h.get(t) ?? []).forEach((f) => f({ preventDefault() {}, ...e })),
    setPointerCapture() {},
  };
}

describe('createHold', () => {
  let doc: ReturnType<typeof target> & { activeElement: any };
  let win: ReturnType<typeof target>;
  let orb: ReturnType<typeof target>;
  let log: string[];
  let live: boolean;
  let enabled: boolean;

  const make = () =>
    createHold({
      orb: orb as any,
      post: (h: boolean) => new Promise<void>((r) => { log.push(`post:${h}`); setTimeout(() => { log.push(`done:${h}`); r(); }, 5); }),
      enabled: () => enabled,
      isLive: () => live,
      send: (m: any) => log.push(`send:${m.message.role}:${m.triggerResponseEnabled}`),
      onChange: () => {},
      onError: (e: Error) => log.push(`error:${e.message}`),
    });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  beforeEach(() => {
    doc = Object.assign(target(), { activeElement: { tagName: 'BODY', getAttribute: () => null } });
    win = target();
    orb = target();
    log = [];
    live = true;
    enabled = true;
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('release awaits post(false) before sending the trigger', async () => {
    make();
    orb.fire('pointerdown', { pointerId: 1, button: 0 });
    orb.fire('pointerup');
    await settle();
    expect(log).toEqual(['post:true', 'done:true', 'post:false', 'done:false', 'send:system:true']);
  });

  it('sends no trigger when no call is live', async () => {
    live = false;
    make();
    orb.fire('pointerdown', { pointerId: 1, button: 0 });
    orb.fire('pointerup');
    await settle();
    expect(log.some((l) => l.startsWith('send'))).toBe(false);
    expect(log).toContain('done:false');
  });

  it('window blur releases without the reply trigger', async () => {
    make();
    orb.fire('pointerdown', { pointerId: 1, button: 0 });
    win.fire('blur');
    await settle();
    expect(log).toContain('done:false');
    expect(log.some((l) => l.startsWith('send'))).toBe(false);
  });

  it('Space holds on the page and releases with the trigger', async () => {
    make();
    doc.fire('keydown', { code: 'Space' });
    doc.fire('keyup', { code: 'Space' });
    await settle();
    expect(log).toEqual(['post:true', 'done:true', 'post:false', 'done:false', 'send:system:true']);
  });

  it('a Space keyup releases even when focus moved to a text field', async () => {
    make();
    doc.fire('keydown', { code: 'Space' });
    doc.activeElement = { tagName: 'INPUT', getAttribute: () => null };
    doc.fire('keyup', { code: 'Space' });
    await settle();
    expect(log).toContain('post:false');
  });

  it('ignores a non-primary pointer button', async () => {
    make();
    orb.fire('pointerdown', { pointerId: 1, button: 2 });
    await settle();
    expect(log).toEqual([]);
  });

  it('Space is ignored on a focused button, in a text field, and with no session', async () => {
    make();
    const prevent = vi.fn();
    doc.activeElement = { tagName: 'BUTTON', getAttribute: () => null };
    doc.fire('keydown', { code: 'Space', preventDefault: prevent });
    doc.activeElement = { tagName: 'INPUT', getAttribute: () => null };
    doc.fire('keydown', { code: 'Space', preventDefault: prevent });
    doc.activeElement = { tagName: 'BODY', getAttribute: () => null };
    enabled = false;
    doc.fire('keydown', { code: 'Space', preventDefault: prevent });
    await settle();
    expect(prevent).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('Space still holds when the orb itself is focused', async () => {
    make();
    doc.activeElement = Object.assign({ tagName: 'BUTTON', getAttribute: () => null });
    // a different button: ignored
    doc.fire('keydown', { code: 'Space' });
    expect(log).toEqual([]);
    doc.activeElement = orb;
    (orb as any).tagName = 'BUTTON';
    (orb as any).getAttribute = () => null;
    doc.fire('keydown', { code: 'Space' });
    await settle();
    expect(log[0]).toBe('post:true');
  });
});
