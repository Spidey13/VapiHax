// npm run film:render -- [draft|final] [Launch]
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const film = path.resolve(import.meta.dirname, '..', 'film');
const [mode = 'final', composition = 'Launch'] = process.argv.slice(2);
if (!['draft', 'final'].includes(mode) || composition !== 'Launch') {
  console.error('usage: npm run film:render -- [draft|final] [Launch]');
  process.exit(2);
}

const draft = mode === 'draft';
const output = draft ? 'renders/launch-picture-draft.mp4' : 'renders/launch-picture.mp4';
const cli = path.join(film, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
execFileSync(process.execPath, [
  cli, 'render', 'src/index.ts', composition, output, '--muted', '--log=warn',
  ...(draft ? ['--scale=0.5', '--crf=28', '--image-format=jpeg'] : []),
], { cwd: film, stdio: 'inherit' });
