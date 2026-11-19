// cd film && npm run transcribe — word timings for the subtitles, from the session audio, with whisper.cpp
// (installed into film/.whisper by Remotion's helper, pinned below). Writes .capture/captions.json as Remotion captions.
// Read the words before using them: fix any word whisper misheard by hand, never the timings.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { downloadWhisperModel, installWhisperCpp, toCaptions, transcribe } from '@remotion/install-whisper-cpp';

const film = path.resolve(import.meta.dirname, '..');
const to = path.join(film, '.whisper');
const version = '1.7.6';
const model = 'medium.en';

await installWhisperCpp({ to, version });
await downloadWhisperModel({ folder: to, model });
const wav = path.join(to, 'session-16k.wav');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(film, 'public', 'session-audio.m4a'), '-ar', '16000', '-ac', '1', wav]);
const out = await transcribe({ inputPath: wav, whisperPath: to, whisperCppVersion: version, model, tokenLevelTimestamps: true, language: 'en' });
const { captions } = toCaptions({ whisperCppOutput: out });
const capture = path.join(film, '.capture');
mkdirSync(capture, { recursive: true });
writeFileSync(path.join(capture, 'captions.json'), JSON.stringify(captions, null, 1));
console.log(`${captions.length} words written to film/.capture/captions.json`);
