import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseTunnelUrl, updateEnvText } from '../src/vapi/assistantConfig.js';
import { syncAssistant } from './vapi-sync.js';
import { acquireLiveLock, waitForServer } from './liveRuntime.js';

try { process.loadEnvFile?.(); } catch { /* ignore */ }
const port = Number(process.env.PORT) || 3000;
const kids: ChildProcess[] = [];
const killAll = () => kids.forEach((k) => { try { k.kill(); } catch { /* */ } });
process.on('SIGINT', () => { killAll(); process.exit(0); });
process.on('SIGTERM', () => { killAll(); process.exit(0); });
process.on('exit', killAll);

try {
  const release = acquireLiveLock(path.resolve('.branch-voice-live.lock'));
  process.on('exit', release);
} catch (error) {
  console.error('live setup failed:', (error as Error).message);
  process.exit(1);
}

// Fail fast when the port is taken, before the tunnel exists or Vapi is re-pointed (the server could not start).
try {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, () => probe.close(() => resolve()));
  });
} catch {
  console.error(`live setup failed: port ${port} is already in use; stop the other server (or set PORT) and retry`);
  process.exit(1);
}

// Order matters: the tunnel URL and the assistant id must be in the environment BEFORE the server starts, because the
// server builds End share links from PUBLIC_URL when it runs. Nothing calls the tunnel until a call starts, so the
// tunnel may exist a few seconds before the server listens.
const winExe = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
const exe = fs.existsSync(winExe) ? winExe : 'cloudflared';
const tunnel = spawn(exe, ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
kids.push(tunnel);
tunnel.on('error', () => { console.error('could not start cloudflared; check that it is installed'); process.exit(1); });
tunnel.on('exit', (c) => { console.error(`cloudflared exited (${c})`); killAll(); process.exit(1); });

const TUNNEL_WAIT_MS = 30_000;
const tunnelUrl = new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`cloudflared printed no tunnel URL within ${TUNNEL_WAIT_MS / 1000} s; check the network and that cloudflared works`)), TUNNEL_WAIT_MS);
  const onData = (b: Buffer) => {
    const url = parseTunnelUrl(b.toString());
    if (url) { clearTimeout(timer); resolve(url); }
  };
  tunnel.stdout?.on('data', onData);
  tunnel.stderr?.on('data', onData);
});

try {
  const url = await tunnelUrl;
  fs.writeFileSync('.env', updateEnvText(fs.readFileSync('.env', 'utf8'), { PUBLIC_URL: url }));
  process.env.PUBLIC_URL = url;
  await syncAssistant(); // also sets process.env.VAPI_ASSISTANT_ID when it creates the assistant
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...process.env, PORT: String(port), PUBLIC_URL: url },
  });
  kids.push(server);
  await waitForServer(server);
  server.on('exit', (code) => { console.error(`server exited (${code}); stopping live`); process.exit(1); });
  console.log(`\nTunnel: ${url}\nOpen the UI: http://localhost:${port}\nCtrl+C to stop.`);
} catch (error) {
  console.error('live setup failed:', (error as Error).message);
  killAll();
  process.exit(1);
}
