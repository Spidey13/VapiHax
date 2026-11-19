const RELEASE_MESSAGE = 'The user released hold; reply now.';

const isTextField = (n) => !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable);

/**
 * Hold-to-talk: press the orb (pointer) or hold space (when focus is not in a text field).
 * Server calls are chained so a release can never overtake its own press, and the release
 * is `await`ed before the reply trigger is sent (the server must see hold=false first).
 * @param {{
 *   orb: HTMLElement,
 *   post: (hold: boolean) => Promise<unknown>,
 *   enabled?: () => boolean,
 *   isLive: () => boolean,
 *   send: (msg: object) => void,
 *   onChange: (active: boolean) => void,
 *   onError: (e: Error) => void,
 * }} o
 */
export function createHold({ orb, post, isLive, send, onChange, onError, enabled = () => true }) {
  let active = false;
  let chain = Promise.resolve();

  /** Space holds only when it would not activate something else, and a session exists. */
  function spaceHolds(e) {
    if (e.code !== 'Space' || !enabled()) return false;
    const a = document.activeElement;
    if (isTextField(a)) return false;
    if (a && a !== orb && (a.tagName === 'BUTTON' || a.tagName === 'A' || a.tagName === 'SUMMARY' || a.getAttribute?.('role') === 'button')) return false;
    return true;
  }

  function press() {
    if (active || !enabled()) return;
    active = true;
    onChange(true);
    chain = chain.then(() => post(true)).catch(onError);
  }

  /** @param {boolean} [trigger] false skips the reply trigger (e.g. the window lost focus) */
  function release(trigger = true) {
    if (!active) return;
    active = false;
    onChange(false);
    chain = chain
      .then(() => post(false))
      .then(() => {
        if (trigger && isLive()) {
          send({ type: 'add-message', message: { role: 'system', content: RELEASE_MESSAGE }, triggerResponseEnabled: true });
        }
      })
      .catch(onError);
  }

  orb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    orb.setPointerCapture?.(e.pointerId);
    press();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) orb.addEventListener(ev, () => release());
  orb.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    if (!spaceHolds(e)) return;
    e.preventDefault(); // also stops a focused button from "clicking"
    if (!e.repeat) press();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !active) return; // any Space keyup ends a hold, wherever focus went
    e.preventDefault();
    release();
  });
  window.addEventListener('blur', () => release(false));

  return { press, release, get active() { return active; } };
}
