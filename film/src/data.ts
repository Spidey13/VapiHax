// The launch film's frame size and length. The clock itself (scenes, beats, captions, cues) is lib/launch/timeline.js.
import { duration } from '../lib/launch/timeline.js';

export const FPS = 30;
export const SIZE: [number, number] = [1920, 1080];
export const DURATION_FRAMES = Math.round(duration * FPS);
