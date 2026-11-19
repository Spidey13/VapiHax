/** Lines a film log (client clock) up with the recording's audio (file clock). Pure; the script does the I/O. */

export interface FilmEvent { t: number; type: string; [k: string]: unknown }
export interface FilmLog { version: number; startedAt: number; events: FilmEvent[] }
/** The film log with `t` in seconds of the recording. */
export interface SessionData { version: 1; offset: number; standIn: boolean; events: FilmEvent[] }

/** Silence spans from `ffmpeg -af silencedetect` stderr; a silence still open at the end closes at `duration`. */
export function parseSilences(stderr: string, duration: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) { open = Math.max(0, Number(s[1])); continue; }
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && open !== null) { out.push({ start: open, end: Number(e[1]) }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: duration });
  return out;
}

/** Where sound begins: the end of every silence that is not the file's end, and 0 when the file starts with sound. */
export function speechOnsets(silences: { start: number; end: number }[], duration: number): number[] {
  const on = silences.filter((s) => s.end < duration - 0.05).map((s) => s.end);
  if (!silences.length || silences[0].start > 0.05) on.unshift(0);
  return on;
}

const nearest = (x: number, sorted: number[]) => {
  let best = Infinity;
  for (const v of sorted) if (Math.abs(v - x) < Math.abs(best - x)) best = v;
  return best;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/**
 * The offset (seconds) to add to event times so they land on audio onsets. Every event/onset pair proposes an
 * offset; the one that matches the most events within `tolerance` wins (ties: the smaller median residual),
 * then it is refined by the median residual of its matches.
 */
export function fitOffset(eventStarts: number[], onsets: number[], tolerance = 0.3): { offset: number; matched: number; residuals: number[] } {
  const sorted = [...onsets].sort((a, b) => a - b);
  const score = (off: number) => {
    const res = eventStarts.map((e) => nearest(e + off, sorted) - (e + off)).filter((r) => Math.abs(r) <= tolerance);
    return { matched: res.length, err: median(res.map(Math.abs)), res };
  };
  let best = { offset: 0, matched: -1, err: Infinity };
  for (const e of eventStarts) {
    for (const o of sorted) {
      const off = o - e;
      const s = score(off);
      if (s.matched > best.matched || (s.matched === best.matched && s.err < best.err)) best = { offset: off, matched: s.matched, err: s.err };
    }
  }
  const first = score(best.offset);
  const offset = best.offset + median(first.res);
  const final = score(offset);
  return { offset, matched: final.matched, residuals: final.res };
}

export function toSessionTime(log: FilmLog, offset: number): SessionData {
  return {
    version: 1,
    offset,
    standIn: false,
    events: log.events.map((e) => ({ ...e, t: Math.round((e.t / 1000 + offset) * 1000) / 1000 })),
  };
}
