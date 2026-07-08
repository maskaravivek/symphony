import { spawn } from 'node:child_process';

import { SymphonyRuntimeError } from '../utils/errors.js';

export interface HookResult {
  stdout: string;
  stderr: string;
  output: string;
}

export class HookScriptError extends SymphonyRuntimeError {
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    opts: {
      stdout: string;
      stderr: string;
      code?: number | null;
      signal?: NodeJS.Signals | null;
    },
  ) {
    super(message);
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.output = [opts.stdout, opts.stderr].filter(Boolean).join('\n');
    this.code = opts.code ?? null;
    this.signal = opts.signal ?? null;
  }
}

export async function runHookScript(script: string, cwd: string, timeoutMs: number, env: Record<string, string> = {}): Promise<HookResult> {
  return await new Promise<HookResult>((resolve, reject) => {
    const child = spawn(script, {
      cwd,
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      detached: true,
    });

    let killedByTimeout = false;
    let stdout = '';
    let stderr = '';
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });

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
        reject(new HookScriptError(`Hook timed out after ${timeoutMs}ms`, { stdout, stderr, code, signal }));
        return;
      }
      if (signal) {
        reject(new HookScriptError(`Hook terminated by signal ${signal}`, { stdout, stderr, code, signal }));
        return;
      }
      if (code !== 0) {
        reject(new HookScriptError(`Hook exited with code ${code}`, { stdout, stderr, code, signal: null }));
        return;
      }
      resolve({ stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n') });
    });
  });
}
