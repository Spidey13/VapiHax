// node film/scripts/launch-render.mjs [draft|final] [--song path --song-start S] [--audio-only]
// cues.json -> mix.wav -> Remotion render of composition `Launch` -> mux (AAC 256k, audio padded to video length)
// -> contact sheet + frame-difference scan, all in film/renders/launch/.
// Frame rate and size come from the `Launch` composition itself (Root.tsx); this script does not override them
// (the draft renders at half resolution).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const film = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const mode = args.find((a) => a === 'draft' || a === 'final') || 'draft';
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const song = opt('--song');
const songStart = opt('--song-start') || '0';
const audioOnly = args.includes('--audio-only');
const win = process.platform === 'win32';
const run = (cmd, a, cwd = film) => execFileSync(cmd, a, { cwd, stdio: 'inherit', shell: win });
const read = (cmd, a) => execFileSync(cmd, a, { cwd: film, shell: win, encoding: 'utf8' }).trim();
const python = process.env.PYTHON || 'python';

const outDir = path.join(film, 'renders', 'launch');
fs.mkdirSync(outDir, { recursive: true });
const cuesJson = path.join(outDir, 'cues.json');
const mixWav = path.join(outDir, `mix-${mode}.wav`);
const video = path.join(outDir, `launch-${mode}.mp4`);
const finalMp4 = path.join(outDir, `launch-${mode}-av.mp4`);
const beats = path.join(film, 'data', 'launch-beats.json');
const audio = (f) => path.join(film, 'audio', f);

// 1. cues from the timeline
run('node', [path.join('scripts', 'launch-cues.mjs'), cuesJson]);
const { duration } = JSON.parse(fs.readFileSync(cuesJson, 'utf8'));

// 2. mix (draft without a song gets a quiet metronome so the motion's timing can be felt)
if (!fs.existsSync(beats)) run(python, [audio('beats.py'), '--placeholder', '96', '100', '--out', beats]);
const mix = [audio('mix.py'), '--cues', cuesJson, '--beats', beats, '--dur', String(duration), '--out', mixWav];
if (song) mix.push('--song', song, '--song-start', songStart);
else if (mode === 'draft') mix.push('--metronome');
run(python, mix);
if (audioOnly) { console.log('audio only:', mixWav); process.exit(0); }

// 3. render the picture (muted: the sound is muxed below)
const rm = ['remotion', 'render', 'src/index.ts', 'Launch', video, '--muted', '--log=warn',
  ...(mode === 'draft' ? ['--scale=0.5', '--crf=28', '--image-format=jpeg'] : ['--crf=16', '--image-format=png'])];
run('npx', rm);

// 4. mux: audio padded (never cut) to the video length
const vdur = read('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]);
run('ffmpeg', ['-y', '-v', 'error', '-i', video, '-i', mixWav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
  '-af', 'apad', '-t', vdur, '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', finalMp4]);
fs.renameSync(finalMp4, video);

// 5. QA
const contact = path.join(outDir, `launch-${mode}-contact.png`);
const report = path.join(outDir, `launch-${mode}-diff.json`);
run(python, [audio('qa.py'), 'contact', video, contact]);
run(python, [audio('qa.py'), 'diff', video, '--seams', cuesJson, '--out', report]);
console.log(`\nvideo:   ${video}\naudio:   ${mixWav}\ncues:    ${cuesJson}\ncontact: ${contact}\ndiff:    ${report}`);
