import { spawn } from 'node:child_process';

import { SymphonyRuntimeError } from '../utils/errors.js';

const DEFAULT_HOOK_CAPTURE_LIMIT_BYTES = 1024 * 1024;

export interface HookResult {
  stdout: string;
  stderr: string;
  output: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export class HookScriptError extends SymphonyRuntimeError {
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly stdout_truncated: boolean;
  readonly stderr_truncated: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    opts: {
      stdout: string;
      stderr: string;
      stdout_truncated?: boolean;
      stderr_truncated?: boolean;
      code?: number | null;
      signal?: NodeJS.Signals | null;
    },
  ) {
    super(message);
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.output = [opts.stdout, opts.stderr].filter(Boolean).join('\n');
    this.stdout_truncated = opts.stdout_truncated ?? false;
    this.stderr_truncated = opts.stderr_truncated ?? false;
    this.code = opts.code ?? null;
    this.signal = opts.signal ?? null;
  }
}

function appendCapturedOutput(current: string, chunk: string, limitBytes: number): { value: string; truncated: boolean } {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= limitBytes) return { value: next, truncated: false };

  let value = next;
  while (Buffer.byteLength(value, 'utf8') > limitBytes) {
    value = value.slice(Math.max(1, value.length - limitBytes));
  }
  return { value, truncated: true };
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
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const captureLimit = Number(process.env.SYMPHONY_HOOK_CAPTURE_LIMIT_BYTES ?? DEFAULT_HOOK_CAPTURE_LIMIT_BYTES);
    const captureLimitBytes = Number.isFinite(captureLimit) && captureLimit > 0 ? Math.floor(captureLimit) : DEFAULT_HOOK_CAPTURE_LIMIT_BYTES;
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
      const captured = appendCapturedOutput(stdout, text, captureLimitBytes);
      stdout = captured.value;
      stdoutTruncated = stdoutTruncated || captured.truncated;
      process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      const captured = appendCapturedOutput(stderr, text, captureLimitBytes);
      stderr = captured.value;
      stderrTruncated = stderrTruncated || captured.truncated;
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
        reject(new HookScriptError(`Hook timed out after ${timeoutMs}ms`, { stdout, stderr, stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated, code, signal }));
        return;
      }
      if (signal) {
        reject(new HookScriptError(`Hook terminated by signal ${signal}`, { stdout, stderr, stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated, code, signal }));
        return;
      }
      if (code !== 0) {
        reject(new HookScriptError(`Hook exited with code ${code}`, { stdout, stderr, stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated, code, signal: null }));
        return;
      }
      resolve({ stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n'), stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated });
    });
  });
}
