import { spawn } from 'node:child_process';

import { SymphonyRuntimeError } from '../utils/errors.js';

export async function runHookScript(script: string, cwd: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(script, {
      cwd,
      shell: true,
      stdio: 'inherit',
      env: process.env,
      detached: true,
    });

    let killedByTimeout = false;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const timeout = setTimeout(() => {
      killedByTimeout = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 5_000).unref();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (killedByTimeout) {
        reject(new SymphonyRuntimeError(`Hook timed out after ${timeoutMs}ms`));
        return;
      }
      if (signal) {
        reject(new SymphonyRuntimeError(`Hook terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new SymphonyRuntimeError(`Hook exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}
