import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export function spawnRunProcess(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
  });
}

export function signalRunProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group has already exited.
    }
  }
  child.kill(signal);
}
