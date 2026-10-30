import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type RunStatus = 'preparing' | 'agent-running' | 'finalizing' | 'retry-wait' | 'completed' | 'failed' | 'cancelled' | 'paused';

export type AgentOutcome = 'completed' | 'failed' | 'cancelled' | null;
export type WorkflowOutcome = 'completed' | 'failed' | 'cancelled' | 'paused' | 'retry-scheduled' | null;

export type AgentMode = 'grooming' | 'autonomous' | 'interactive-handoff' | 'planning' | 'resolve-conflicts' | 'pr-review';
export type CodexMode = AgentMode;

export type PauseReason = 'interactive' | 'needs-info' | null;

export interface FinalizationContext {
  mode: AgentMode;
  review_pr: {
    pr_number: number;
    pr_url: string | null;
    head_ref: string;
    head_sha: string | null;
    base_ref: string;
    base_sha: string | null;
    originating_issue_number: number | null;
    review_key: string;
    lens: string;
    feedback_round?: number;
    max_feedback_rounds?: number;
    feedback_priorities?: string[];
    has_blocking_feedback?: boolean;
    followup_only?: boolean;
  } | null;
}

export interface RunState {
  loop_id?: string;
  loop_run_id?: string;
  loop_run_started_at?: string;
  loop_coordinator_pid?: number | null;
  loop_inputs?: Array<{marker:string;comment_id:number;text:string}>;
  loop_resume_requested?: boolean;
  repo_id: string | null;
  owner: string | null;
  repo: string | null;

  issue_id: string;
  issue_number: number | null;
  issue_identifier: string;
  issue_url: string | null;
  issue_title?: string | null;
  issue_state?: string | null;
  labels?: string[];
  workflow_state?: string | null;

  workspace_path: string;
  workspace_strategy?: string | null;

  grooming_source_sha?: string;
  grooming_input_labels?: string[];
  grooming_result?: import('../grooming/grooming.js').GroomingResult;
  attempt: number;
  session_id: string | null;
  agent_provider?: string | null;
  agent_provider_group?: string | null;
  agent_provider_kind?: string | null;
  agent_thread_id?: string | null;
  agent_mode?: AgentMode | null;
  agent_log_path?: string | null;
  codex_thread_id: string | null;
  codex_mode: CodexMode | null;
  pause_reason: PauseReason;
  worker_pid: number | null;
  session_artifact_dir?: string | null;
  agent_finished_at?: string | null;
  agent_outcome?: AgentOutcome;
  workflow_outcome?: WorkflowOutcome;
  retry_reason?: string | null;
  retry_not_before?: string | null;
  finalization_context?: FinalizationContext | null;
  finalization_step?: 'pending' | 'hook-running' | 'hook-completed' | 'effects-applied' | null;

  followup_worktree_status?: string;
  preparation_incomplete?: boolean;
  preparation_failure_count?: number;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;

  last_exit_code: number | null;
  last_signal: string | null;
  last_error: string | null;

  prompt_path: string | null;
  agent_output_path?: string | null;
  codex_jsonl_path: string | null;
  last_message_path: string | null;
  last_seen_comment_id: number | null;
  last_seen_pr_review_comment_id?: number | null;
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
    await fs.writeFile(tmpPath, `${JSON.stringify(runState, null, 2)}\n`, {encoding:'utf8',mode:0o600});
    await fs.rename(tmpPath, runPath);
    if (runState.session_artifact_dir) {
      const manifestPath = path.join(runState.session_artifact_dir, 'manifest.json');
      try {
        const current = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
        await fs.writeFile(manifestPath, `${JSON.stringify({
          ...current,
          phase: runState.status,
          agent_outcome: runState.agent_outcome ?? null,
          workflow_outcome: runState.workflow_outcome ?? null,
          agent_finished_at: runState.agent_finished_at ?? null,
          finished_at: runState.finished_at,
          updated_at: runState.updated_at,
        }, null, 2)}\n`, { mode: 0o600 });
      } catch {
        // The manifest is created immediately after the initial run state.
      }
    }
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
