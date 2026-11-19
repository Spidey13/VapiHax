/**
 * Progress of the endpointing-wait arc, clamped to [0, 1].
 * @param {number} nowMs
 * @param {number | null} stoppedAtMs
 * @param {number} waitMs
 */
export function arcProgress(nowMs, stoppedAtMs, waitMs) {
  if (stoppedAtMs == null) return 0;
  if (waitMs <= 0) return 1;
  return Math.min(1, Math.max(0, (nowMs - stoppedAtMs) / waitMs));
}
