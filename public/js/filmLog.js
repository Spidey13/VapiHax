// Film log: with ?film=1 the client keeps a timestamped record of what the screen did (speech, captions,
// accepted states, structural animations) so a launch film can be rendered from a real session.
// Off by default; it never draws anything and holds no token.

/** @param {string} search location.search */
export function filmFlag(search) {
  try { return new URLSearchParams(search).get('film') === '1'; } catch { return false; }
}

/**
 * @param {{ enabled: boolean, now?: () => number, wall?: () => number }} o
 *   now: a monotonic ms clock (performance.now); wall: Date.now, kept once for the record.
 */
export function createFilmLog({ enabled, now = () => performance.now(), wall = () => Date.now() }) {
  const t0 = now();
  const startedAt = wall();
  /** @type {any[]} */
  const events = [];
  let lastRevision = null;
  const add = (e) => { if (enabled) events.push({ t: Math.round((now() - t0) * 10) / 10, ...e }); };
  return {
    on: enabled,
    speech: (role, status) => add({ type: 'speech', role, status }),
    transcript: (role, final, text) => add({ type: 'transcript', role, final: !!final, text }),
    playback: (turn, source, text) => add({ type: 'playback', turn, source, text }),
    state(s) {
      if (!enabled || !s || s.revision === lastRevision) return;
      lastRevision = s.revision;
      add({ type: 'state', state: JSON.parse(JSON.stringify(s)) });
    },
    play: (phase, kind, revision) => add({ type: 'play', phase, kind, revision }),
    hold: (on) => add({ type: 'hold', on: !!on }),
    end: () => add({ type: 'end' }),
    share: (data) => add({ type: 'share', data: JSON.parse(JSON.stringify(data ?? null)) }),
    toJSON: () => ({ version: 1, startedAt, events: events.slice() }),
  };
}

/** Save the log as a JSON file (browser only). */
export function downloadFilmLog(log, name = 'branch-voice-film-log.json') {
  const blob = new Blob([JSON.stringify(log.toJSON())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
