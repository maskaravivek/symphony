import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { SymphonyRuntimeError } from '../utils/errors.js';

const DEFAULT_HOOK_CAPTURE_LIMIT_BYTES = 1024 * 1024;

export interface HookResult {
  stdout: string;
  stderr: string;
  output: string;
  log_path: string | null;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface HookRunOptions {
  env?: Record<string, string>;
  logPath?: string | null;
  streamOutput?: boolean;
  signal?: AbortSignal;
}

export class HookScriptError extends SymphonyRuntimeError {
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly log_path: string | null;
  readonly stdout_truncated: boolean;
  readonly stderr_truncated: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    opts: {
      stdout: string;
      stderr: string;
      log_path?: string | null;
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
    this.log_path = opts.log_path ?? null;
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

function isHookRunOptions(value: HookRunOptions | Record<string, string>): value is HookRunOptions {
  return 'env' in value || 'logPath' in value || 'streamOutput' in value || 'signal' in value;
}

function normalizeHookRunOptions(optionsOrEnv: HookRunOptions | Record<string, string> = {}): Required<Pick<HookRunOptions, 'env' | 'streamOutput'>> & Pick<HookRunOptions, 'logPath' | 'signal'> {
  if (isHookRunOptions(optionsOrEnv)) {
    return {
      env: optionsOrEnv.env ?? {},
      logPath: optionsOrEnv.logPath ?? null,
      streamOutput: optionsOrEnv.streamOutput ?? false,
      signal: optionsOrEnv.signal,
    };
  }
  return { env: optionsOrEnv, logPath: null, streamOutput: false, signal: undefined };
}

function closeLogStream(stream: WriteStream | null): Promise<void> {
  if (!stream || stream.closed || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('error', () => resolve());
    stream.end(() => resolve());
  });
}

export async function runHookScript(script: string, cwd: string, timeoutMs: number, optionsOrEnv: HookRunOptions | Record<string, string> = {}): Promise<HookResult> {
  const options = normalizeHookRunOptions(optionsOrEnv);
  const logPath = options.logPath ?? null;
  let logStream: WriteStream | null = null;
  if (logPath) {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', () => {
      // Hook execution should not fail solely because diagnostics could not be written.
    });
  }
  if (options.signal?.aborted) {
    await closeLogStream(logStream);
    throw new HookScriptError(`Hook cancelled: ${String(options.signal.reason ?? 'aborted')}`, {
      stdout: '',
      stderr: '',
      log_path: logPath,
    });
  }

  return await new Promise<HookResult>((resolve, reject) => {
    const child = spawn(script, {
      cwd,
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
      detached: true,
    });

    let killedByTimeout = false;
    let killedByAbort = false;
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

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      void (async () => {
        clearTimeout(timeout);
        await closeLogStream(logStream);
        fn();
      })();
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      const captured = appendCapturedOutput(stdout, text, captureLimitBytes);
      stdout = captured.value;
      stdoutTruncated = stdoutTruncated || captured.truncated;
      if (logStream) logStream.write(text);
      if (options.streamOutput) process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      const captured = appendCapturedOutput(stderr, text, captureLimitBytes);
      stderr = captured.value;
      stderrTruncated = stderrTruncated || captured.truncated;
      if (logStream) logStream.write(text);
      if (options.streamOutput) process.stderr.write(text);
    });

    const timeout = setTimeout(() => {
      killedByTimeout = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 5_000).unref();
    }, timeoutMs);

    const abortHook = () => {
      killedByAbort = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 5_000).unref();
    };
    options.signal?.addEventListener('abort', abortHook, { once: true });

    child.on('error', (err) => {
      options.signal?.removeEventListener('abort', abortHook);
      settle(() => reject(err));
    });

    child.on('exit', (code, signal) => {
      options.signal?.removeEventListener('abort', abortHook);
      if (killedByTimeout) {
        settle(() =>
          reject(
            new HookScriptError(`Hook timed out after ${timeoutMs}ms`, {
              stdout,
              stderr,
              log_path: logPath,
              stdout_truncated: stdoutTruncated,
              stderr_truncated: stderrTruncated,
              code,
              signal,
            }),
          ),
        );
        return;
      }
      if (killedByAbort) {
        settle(() =>
          reject(
            new HookScriptError(`Hook cancelled: ${String(options.signal?.reason ?? 'aborted')}`, {
              stdout,
              stderr,
              log_path: logPath,
              stdout_truncated: stdoutTruncated,
              stderr_truncated: stderrTruncated,
              code,
              signal,
            }),
          ),
        );
        return;
      }
      if (signal) {
        settle(() =>
          reject(
            new HookScriptError(`Hook terminated by signal ${signal}`, {
              stdout,
              stderr,
              log_path: logPath,
              stdout_truncated: stdoutTruncated,
              stderr_truncated: stderrTruncated,
              code,
              signal,
            }),
          ),
        );
        return;
      }
      if (code !== 0) {
        settle(() =>
          reject(
            new HookScriptError(`Hook exited with code ${code}`, {
              stdout,
              stderr,
              log_path: logPath,
              stdout_truncated: stdoutTruncated,
              stderr_truncated: stderrTruncated,
              code,
              signal: null,
            }),
          ),
        );
        return;
      }
      settle(() =>
        resolve({
          stdout,
          stderr,
          output: [stdout, stderr].filter(Boolean).join('\n'),
          log_path: logPath,
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated,
        }),
      );
    });
  });
}
