// node film/scripts/launch-cues.mjs <out.json>
// Writes { duration, cues, seams, hits } from film/lib/launch/timeline.js (cues(), duration, SCENES).
// The timeline imports JSON; if Node cannot import it directly, it is bundled with esbuild into a temp file first.
// LAUNCH_TIMELINE=<path> overrides the module (used to test this script against a fake timeline).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const film = path.resolve(import.meta.dirname, '..');
const out = process.argv[2];
if (!out) { console.error('usage: node film/scripts/launch-cues.mjs <out.json>'); process.exit(2); }
const timeline = path.resolve(process.env.LAUNCH_TIMELINE || path.join(film, 'lib', 'launch', 'timeline.js'));

async function load() {
  try {
    return await import(pathToFileURL(timeline).href);
  } catch (e) {
    // plain import failed (JSON import attributes, extensionless imports, ...): bundle then import
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-cues-'));
    const bundled = path.join(dir, 'timeline.bundle.mjs');
    const esbuild = path.join(film, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
    execFileSync(esbuild, [timeline, '--bundle', '--platform=node', '--format=esm', '--loader:.json=json', `--outfile=${bundled}`, '--log-level=warning'],
      { stdio: 'inherit', shell: process.platform === 'win32' });
    return await import(pathToFileURL(bundled).href);
  }
}

const mod = await load();
const cues = (typeof mod.cues === 'function' ? mod.cues() : mod.cues).map((c) => ({ t: c.t, kind: c.kind, gain: c.gain ?? 1, pan: c.pan ?? 0 }));
const seams = (mod.SCENES || []).map((s) => s.start ?? s.t0);
const HIT = new Set(['fork', 'fix', 'back', 'compare', 'merge', 'settle']);
const hits = cues.filter((c) => HIT.has(c.kind)).map((c) => c.t);
const duration = typeof mod.duration === 'function' ? mod.duration() : mod.duration;
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ duration, cues, seams, hits }, null, 1));
console.log(`cues: ${out}  duration ${duration}s, ${cues.length} cues, ${seams.length} seams, ${hits.length} hits`);
