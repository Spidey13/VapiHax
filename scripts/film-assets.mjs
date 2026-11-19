// Writes film/data/assets.json: which media files are in film/public (the film draws a placeholder or stays
// silent where one is missing). Run before Studio and before rendering.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const film = path.resolve(import.meta.dirname, '..', 'film');
const has = (f) => existsSync(path.join(film, 'public', f));
const assets = { recording: has('recording.mp4'), sessionAudio: has('session-audio.m4a'), music: has('music.mp3') };
writeFileSync(path.join(film, 'data', 'assets.json'), `${JSON.stringify(assets, null, 1)}\n`);
console.log(`media: ${Object.entries(assets).map(([k, v]) => `${k} ${v ? 'yes' : 'no'}`).join(', ')}`);
