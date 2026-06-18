import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';

export type CodexMode = 'autonomous' | 'interactive-handoff' | 'resolve-conflicts';

export type PauseReason = 'interactive' | 'needs-info' | null;

export interface RunState {
  repo_id: string | null;
  owner: string | null;
  repo: string | null;

  issue_id: string;
  issue_number: number | null;
  issue_identifier: string;
  issue_url: string | null;
  labels?: string[];
  workflow_state?: string | null;

  workspace_path: string;

  attempt: number;
  session_id: string | null;
  codex_thread_id: string | null;
  codex_mode: CodexMode | null;
  pause_reason: PauseReason;
  worker_pid: number | null;

  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;

  last_exit_code: number | null;
  last_signal: string | null;
  last_error: string | null;

  prompt_path: string | null;
  codex_jsonl_path: string | null;
  last_message_path: string | null;
  last_seen_comment_id: number | null;
  status_comment_id: number | null;
  last_handoff_at: string | null;

  updated_at: string;
}

export function getRunStatePath(workspacePath: string): string {
  return path.join(workspacePath, '.symphony', 'run.json');
}

export async function readRunState(workspacePath: string): Promise<RunState | null> {
  const runPath = getRunStatePath(workspacePath);
  try {
    const raw = await fs.readFile(runPath, 'utf8');
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export async function writeRunState(workspacePath: string, runState: RunState): Promise<void> {
  const dir = path.join(workspacePath, '.symphony');
  await fs.mkdir(dir, { recursive: true });
  const runPath = getRunStatePath(workspacePath);
  const tmpPath = `${runPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(runState, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, runPath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

export async function updateRunState(
  workspacePath: string,
  updater: (current: RunState | null) => RunState | null,
): Promise<void> {
  const current = await readRunState(workspacePath);
  const next = updater(current);
  if (!next) return;
  await writeRunState(workspacePath, next);
}
