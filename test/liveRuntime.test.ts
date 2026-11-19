import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { acquireLiveLock, waitForServer } from '../scripts/liveRuntime.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('live launcher ownership', () => {
  it('rejects a competing launcher until the owner releases its lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-voice-live-'));
    dirs.push(dir);
    const file = path.join(dir, 'live.lock');
    const release = acquireLiveLock(file);
    expect(() => acquireLiveLock(file)).toThrow(/already running/);
    release();
    const nextRelease = acquireLiveLock(file);
    release(); // old cleanup must never delete a new owner's lock
    expect(() => acquireLiveLock(file)).toThrow(/already running/);
    nextRelease();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('fails safely on a leftover lock and explains how to recover', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-voice-live-'));
    dirs.push(dir);
    const file = path.join(dir, 'live.lock');
    fs.writeFileSync(file, 'stale');
    expect(() => acquireLiveLock(file)).toThrow(/remove.*lock/i);
    expect(fs.readFileSync(file, 'utf8')).toBe('stale');
  });
});

describe('server startup gate', () => {
  it('waits for explicit readiness before allowing tunnel setup', async () => {
    const child = new EventEmitter() as ChildProcess;
    const ready = waitForServer(child);
    child.emit('message', { type: 'other' });
    child.emit('message', { type: 'ready' });
    await expect(ready).resolves.toBeUndefined();
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('rejects a server that exits before listening', async () => {
    const child = new EventEmitter() as ChildProcess;
    const ready = waitForServer(child);
    child.emit('exit', 1, null);
    await expect(ready).rejects.toThrow(/server exited before listening/);
  });

  it('rejects a process launch error', async () => {
    const child = new EventEmitter() as ChildProcess;
    const ready = waitForServer(child);
    child.emit('error', new Error('spawn failed'));
    await expect(ready).rejects.toThrow('spawn failed');
  });
});
