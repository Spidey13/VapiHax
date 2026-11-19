const MIN_DY = 80;
const MAX_DT_MS = 600;

/**
 * @param {{ dy: number, dt: number, startedAtTop: boolean }} g
 * @returns {'switch-back' | null}
 */
export function swipeIntent({ dy, dt, startedAtTop }) {
  return startedAtTop && dy >= MIN_DY && dt <= MAX_DT_MS ? 'switch-back' : null;
}

/** True when a touch began on the sheet header area (name tag or origin line). */
export const startsOnHeader = (target) => !!target?.closest?.('.tag, .origin');
