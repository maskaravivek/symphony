import { dependencyHelperPath } from '../utils/runtimePaths.js';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import fs from 'node:fs';

import { SymphonyRuntimeError } from '../utils/errors.js';
import { log, type LogFields } from '../utils/log.js';

export interface AgentRunOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  turnTimeoutMs: number;
  logFields: LogFields;
  onStdoutLine?: (line: string) => void;
  sessionId?: string;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface AgentRunResult {
  session_id: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  cancel: (reason: string) => Promise<void>;
}

function attachOutputLogger(
  child: ChildProcessByStdio<null, Readable, Readable>,
  stream: 'stdout' | 'stderr',
  fields: LogFields,
  onLine?: (line: string) => void,
  outputPath?: string,
): void {
  const output = outputPath ? fs.createWriteStream(outputPath, { flags: 'a', mode: 0o600 }) : null;
  if (output) child[stream].pipe(output);
  const rl = createInterface({ input: child[stream] });
  rl.on('line', (line) => {
    log('debug', 'agent_output', { ...fields, event: 'agent_output', stream, line });
    if (stream === 'stdout') onLine?.(line);
  });
  child.on('exit', () => {
    rl.close();
    output?.end();
  });
}

function signalProcessGroup(child: ChildProcessByStdio<null, Readable, Readable>, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function killProcess(
  child: ChildProcessByStdio<null, Readable, Readable>,
  reason: string,
  fields: LogFields,
): Promise<void> {
  log('warn', 'worker_cancel_requested', { ...fields, event: 'worker_cancel_requested', reason });
  if (child.exitCode !== null || child.signalCode !== null) return;

  signalProcessGroup(child, 'SIGTERM');

  const killed = await Promise.race([
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      child.on('exit', () => resolve(true));
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);

  if (!killed) {
    log('warn', 'worker_sigkill', { ...fields, event: 'worker_sigkill', reason });
    signalProcessGroup(child, 'SIGKILL');
    await Promise.race([
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

export function runAgent(options: AgentRunOptions): AgentRunResult {
  const sessionId = options.sessionId ?? randomUUID();

  const child = spawn(options.command, {
    cwd: options.cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, SYMPHONY_DEPENDENCY_HELPER: dependencyHelperPath(), ...options.env },
  });

  const fields = { ...options.logFields, session_id: sessionId };
  attachOutputLogger(child, 'stdout', fields, options.onStdoutLine, options.stdoutPath);
  attachOutputLogger(child, 'stderr', fields, undefined, options.stderrPath);

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', (err) => reject(err));
    child.on('exit', (code, signal) => resolve({ code, signal: signal as NodeJS.Signals | null }));
  });

  const timeout = setTimeout(() => {
    void killProcess(child, `turn_timeout_ms exceeded (${options.turnTimeoutMs})`, fields);
  }, options.turnTimeoutMs);
  timeout.unref();

  exit.finally(() => clearTimeout(timeout)).catch(() => {
    // handled by awaiters
  });

  return {
    session_id: sessionId,
    child,
    exit,
    cancel: async (reason: string) => {
      await killProcess(child, reason, fields);
    },
  };
}

export function assertAgentEligibleCommand(command: string, keyPath = 'agent command'): void {
  if (!command.trim()) throw new SymphonyRuntimeError(`${keyPath} must be non-empty`);
}
