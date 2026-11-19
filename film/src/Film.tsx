// The launch film. Every frame is a pure function of film time: lib/launch/draw.js paints it (the real session replayed
// through the app's own code, the camera, the light, the captions); this component only calls draw(frame / fps).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import '../app/style.css';
import '../app/film-overrides.css';
import '../lib/launch/launch.css';
import '../lib/launch/lights.css';
import { forceFullMotion } from '../lib/fullMotion.js';
import { createStage } from '../lib/launch/draw.js';

export const Film: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<ReturnType<typeof createStage> | null>(null);
  const [handle] = useState(() => delayRender('Drawing the launch film'));
  useLayoutEffect(() => {
    if (!stage.current) {
      forceFullMotion(); // the film shows the app's designed motion even if this machine asks for reduced motion
      stage.current = createStage(host.current!);
    }
    stage.current.draw(frame / fps);
  }, [frame, fps]);
  useEffect(() => { continueRender(handle); }, [handle]);
  return <AbsoluteFill><div ref={host} style={{ width: 1920, height: 1080 }} /></AbsoluteFill>;
};
