import { Composition } from 'remotion';
import { Film } from './Film';
import { DURATION_FRAMES, FPS, SIZE } from './data';
import './fonts';

// One composition: the launch film. The draft render uses --scale=0.5 (960 x 540); the final renders 1920 x 1080.
export const RemotionRoot: React.FC = () => (
  <Composition id="Launch" component={Film} durationInFrames={DURATION_FRAMES} fps={FPS} width={SIZE[0]} height={SIZE[1]} />
);
