// The whole frame as one function of film time. createStage(root) builds the DOM once; draw(t) paints frame t:
// the app (the real session replayed to the scene's session moment, or the film's own hook/start/end screens)
// under the camera, the lights above it, the captions and the hook beside it. Remotion and the probe page both
// only call draw(t).
import { createReplay } from '../replay.js';
import { SESSION, sceneAt, duration } from './timeline.js';
import { camera, cameraTransform } from './camera.js';
import { createCaptions } from './captions.js';
import { createScreens, createHook, seamFx } from './screens.js';
import { createLights } from './lights.js';
import { smooth } from './springs.js';

export { duration };

/** @param {HTMLElement} root an empty element, 1920 x 1080 */
export function createStage(root) {
  root.innerHTML = `<div id="frame">
    <div id="backdrop"></div>
    <div id="cam"><div id="app"></div><div id="lights"></div><div id="cursor-layer"></div></div>
    <div id="hook"></div>
    <aside id="cap"></aside>
  </div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  const frame = $('frame');
  const cam = $('cam');
  const app = $('app');
  const replay = createReplay(app, SESSION); // one instance; renderAt rebuilds the app each frame
  const screens = createScreens({ host: app, cursorLayer: $('cursor-layer') });
  const hook = createHook($('hook'));
  const captions = createCaptions($('cap'));
  const lights = createLights({ layer: $('lights'), frame, appHost: app });
  let mode = 'replay'; // what #app holds: 'replay' (the app) or 'screen' (the film's own glass)

  function draw(t) {
    const s = sceneAt(t);
    const c = camera(t);
    cam.style.transform = cameraTransform(c);

    if (s.src != null) {
      if (mode !== 'replay') { screens.invalidate(); mode = 'replay'; }
      replay.renderAt(s.src);
      // the words go soft behind the map when the camera is on the map (the storyboard's depth of field)
      const tr = app.querySelector('#transcript');
      const f = smooth((c.z - 1.7) / 0.3);
      if (tr && f > 0.001) {
        tr.style.setProperty('filter', `blur(${(5 * f).toFixed(2)}px)`, 'important');
        tr.style.setProperty('opacity', (1 - 0.65 * f).toFixed(3), 'important');
      }
    } else {
      if (mode !== 'screen') { replay.dispose(); mode = 'screen'; }
      screens.draw(s.scene === 'hook' ? 'hook' : s.scene === 'start' ? 'start' : 'end', t);
    }

    // the seam: the app layer only; the lights, the captions and the backdrop glass never blur or cut
    const seam = seamFx(t);
    app.style.opacity = seam.op.toFixed(4);
    app.style.filter = seam.blur > 0.05 ? `blur(${(seam.blur / c.z).toFixed(3)}px)` : 'none';

    lights.draw({ t, src: s.src, scene: s.scene, sceneT: s.sceneT, sceneDur: s.sceneDur, zoom: c.z });
    hook.draw(t);
    captions.draw(t);
  }

  return { draw, duration };
}
