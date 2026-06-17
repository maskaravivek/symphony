import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { SymphonyRuntimeError } from '../utils/errors.js';
import { log, type LogFields } from '../utils/log.js';

export interface AgentRunOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  turnTimeoutMs: number;
  logFields: LogFields;
  onStdoutLine?: (line: string) => void;
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
): void {
  const rl = createInterface({ input: child[stream] });
  rl.on('line', (line) => {
    log('debug', 'agent_output', { ...fields, event: 'agent_output', stream, line });
    if (stream === 'stdout') onLine?.(line);
  });
  child.on('exit', () => rl.close());
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
  signalProcessGroup(child, 'SIGTERM');

  const killed = await Promise.race([
    new Promise<boolean>((resolve) => {
      child.on('exit', () => resolve(true));
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);

  if (!killed) {
    log('warn', 'worker_sigkill', { ...fields, event: 'worker_sigkill', reason });
    signalProcessGroup(child, 'SIGKILL');
  }
}

export function runAgent(options: AgentRunOptions): AgentRunResult {
  const sessionId = randomUUID();

  const child = spawn(options.command, {
    cwd: options.cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, ...options.env },
  });

  const fields = { ...options.logFields, session_id: sessionId };
  attachOutputLogger(child, 'stdout', fields, options.onStdoutLine);
  attachOutputLogger(child, 'stderr', fields);

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

export function assertAgentEligibleCommand(command: string): void {
  if (!command.trim()) throw new SymphonyRuntimeError('codex.command must be non-empty');
}
