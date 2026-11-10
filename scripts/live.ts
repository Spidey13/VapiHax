import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { parseTunnelUrl, updateEnvText } from '../src/vapi/assistantConfig.js';
import { syncAssistant } from './vapi-sync.js';

try { process.loadEnvFile?.(); } catch { /* ignore */ }
const port = Number(process.env.PORT) || 3000;
const kids: ChildProcess[] = [];
const killAll = () => kids.forEach((k) => { try { k.kill(); } catch { /* */ } });
process.on('SIGINT', () => { killAll(); process.exit(0); });
process.on('exit', killAll);

kids.push(spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { stdio: 'inherit', env: { ...process.env, PORT: String(port) } }));

const winExe = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
const exe = fs.existsSync(winExe) ? winExe : 'cloudflared';
const tunnel = spawn(exe, ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
kids.push(tunnel);

let done = false;
const onData = async (b: Buffer) => {
  if (done) return;
  const url = parseTunnelUrl(b.toString());
  if (!url) return;
  done = true;
  try {
    fs.writeFileSync('.env', updateEnvText(fs.readFileSync('.env', 'utf8'), { PUBLIC_URL: url }));
    process.env.PUBLIC_URL = url;
    await syncAssistant();
    console.log(`\nTunnel: ${url}\nOpen the UI: http://localhost:${port}\nCtrl+C to stop.`);
  } catch (e) {
    console.error('live setup failed:', (e as Error).message);
    killAll();
    process.exit(1);
  }
};
tunnel.stdout?.on('data', onData);
tunnel.stderr?.on('data', onData);
tunnel.on('exit', (c) => { console.error(`cloudflared exited (${c})`); killAll(); process.exit(1); });
