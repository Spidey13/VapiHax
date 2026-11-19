/**
 * Recap and compare: rows of the branch map expand to show their last line.
 * Decorative (the assistant says the same thing aloud). Text goes in via textContent in branchMapView.
 */
export const RECAP_MS = 2500;
export const COMPARE_MS = 3000;
const SNIPPET = 140;

const clip = (text) => {
  const chars = Array.from(text ?? '');
  return chars.length > SNIPPET ? `${chars.slice(0, SNIPPET - 1).join('')}…` : chars.join('');
};

function lastLine(path) {
  const last = (path ?? []).at(-1);
  return clip(last?.text ?? '');
}

/** Recap: every row shows where it left off, then settles back. */
export function playRecap(map, state) {
  const { current, others = [], parked = [] } = state.sheets;
  const lines = { [current.id]: lastLine(current.path) };
  for (const s of [...others, ...parked]) lines[s.id] = clip(s.lastLine);
  return map.emphasize('all', { ms: RECAP_MS, lines });
}

/** Compare: the two rows show their last lines; the rest dim. */
export function playCompare(map, state, otherId) {
  const { current, others = [], parked = [] } = state.sheets;
  const other = [...others, ...parked].find((s) => s.id === otherId) ?? others[0] ?? parked[0];
  if (!other) return Promise.resolve();
  const lines = { [current.id]: lastLine(current.path), [other.id]: clip(other.lastLine) };
  return map.emphasize([current.id, other.id], { ms: COMPARE_MS, lines, dim: true });
}
