/**
 * npm run film:sync -- <film-log.json> <recording.mp4>
 * Lines the film log up with the recording's audio and writes film/.capture/session.json and
 * film/public/session-audio.m4a (plus film/public/recording.mp4, the picture for the opener).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fitOffset, parseSilences, speechOnsets, toSessionTime, type FilmLog } from '../src/film/sync.js';

const [logPath, recPath] = process.argv.slice(2);
if (!logPath || !recPath) {
  console.error('usage: npm run film:sync -- <film-log.json> <recording.mp4>');
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, 'film', 'public');
const data = path.join(root, 'film', '.capture');
mkdirSync(assets, { recursive: true });
mkdirSync(data, { recursive: true });

const log = JSON.parse(readFileSync(logPath, 'utf8')) as FilmLog;
if (log.version !== 1) throw new Error(`unknown film log version ${log.version}`);

const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', recPath]).toString().trim());
const audio = path.join(assets, 'session-audio.m4a');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', recPath, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', audio]);
const det = spawnSync('ffmpeg', ['-i', audio, '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'], { encoding: 'utf8' });
const onsets = speechOnsets(parseSilences(det.stderr, duration), duration);

const starts = (role?: string) => log.events
  .filter((e) => e.type === 'speech' && e.status === 'started' && (!role || e.role === role))
  .map((e) => e.t / 1000);
// The assistant's start is when its audio begins playing; the user's arrives after voice detection, so it runs late.
const assistant = starts('assistant');
const fit = fitOffset(assistant.length >= 5 ? assistant : starts(), onsets);
console.log(`offset ${fit.offset.toFixed(3)} s, ${fit.matched} speech starts matched`);
console.log(`residuals (ms): ${fit.residuals.map((r) => Math.round(r * 1000)).join(' ')}`);
if (fit.matched < 5) {
  console.error('Fewer than five speech starts line up with the audio. Is this the recording of this session?');
  process.exit(1);
}

writeFileSync(path.join(data, 'session.json'), JSON.stringify(toSessionTime(log, fit.offset), null, 1));
copyFileSync(recPath, path.join(assets, 'recording.mp4'));
console.log('wrote film/.capture/session.json, film/public/session-audio.m4a, film/public/recording.mp4');
console.log('next: npm --prefix film run transcribe (optional subtitle timings)');
