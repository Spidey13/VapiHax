import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

/** Exclusive across launchers, including launchers configured with different HTTP ports. */
export function acquireLiveLock(file: string): () => void {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`npm run live is already running, or left a lock after a crash. Stop the existing launcher; if no launcher or its server/tunnel remains, remove the lock at ${file} and retry.`);
  }
  fs.writeFileSync(fd, `${process.pid}\n`);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.closeSync(fd);
    fs.unlinkSync(file);
  };
}

/** A running process is not enough: it must have successfully acquired its HTTP port. */
export function waitForServer(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exited);
      child.off('error', failed);
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = (code: number | null) => failed(new Error(`server exited before listening (${code}); check PORT and stop any existing server`));
    const message = (m: unknown) => {
      if ((m as { type?: string } | null)?.type !== 'ready') return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => failed(new Error('server did not become ready in time')), timeoutMs);
    child.on('message', message);
    child.once('exit', exited);
    child.once('error', failed);
  });
}
