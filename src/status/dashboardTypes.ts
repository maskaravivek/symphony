/**
 * Shared contract for the Symphony dashboard.
 *
 * Three producers and one consumer agree on these shapes:
 *  - the orchestrator writes heartbeat files (RepoHeartbeat, OrchestratorHeartbeat);
 *  - the status read models build OverviewState, RepoState, TaskDetail, HistoryState;
 *  - the dashboard server serves them over JSON and the static UI renders them.
 *
 * Fields may be added; existing fields must not be renamed or change meaning.
 */

import type { RunState, RunStatus, AgentMode } from './runState.js';

// ---------------------------------------------------------------------------
// Heartbeats written by the orchestrator
// ---------------------------------------------------------------------------

/** Written atomically to `<workspace.root>/.symphony/heartbeat.json` on every repo tick. */
export interface RepoHeartbeat {
  version: 1;
  repo_id: string | null;
  owner: string;
  repo: string;
  pid: number;
  tick_started_at: string;
  tick_finished_at: string | null;
  /** `ok` ran the full tick; `skipped` returned early (lock, backoff, load failure); `error` threw. */
  tick_outcome: 'ok' | 'skipped' | 'error';
  /** e.g. `workflow_lock_unavailable`, `github_rate_limit_backoff`, `workflow_load_failed`, `github_candidate_fetch_failed`. */
  tick_skip_reason: string | null;
  tick_error: string | null;
  /** Added by HEARTBEAT: last WORKFLOW.md load/validation error; the tick ran on the last good config when set. */
  workflow_load_error?: string | null;
  poll: {
    candidate_count: number;
    grooming_count: number;
    active_count: number;
    retry_count: number;
    capacity_remaining: number | null;
  } | null;
  capacity: {
    max_concurrent_agents: number;
    running: number;
  };
  storage: {
    blocked: boolean;
    minimum_free_gib: number;
    free_gib: number | null;
  };
  github_rate_limit_backoff_until: string | null;
  provider_backoff: Array<{ provider: string; limit_key: string; until: string }>;
  /** Deferrals observed during this tick (workspace pool limit, protected work, ...). */
  dispatch_deferrals: Array<{ at: string; reason: string; issue_number: number | null }>;
  /** Capacity blocks observed during this tick, aggregated by reason. */
  dispatch_blocks: Array<{ reason: 'global_capacity' | 'state_capacity' | 'provider_capacity' | 'usage_limit'; count: number }>;
  /** Workspaces the terminal sweep could not clean during this tick. */
  protected_workspaces: Array<{ path: string; issue_number: number | null; reason: string }>;
}

/** Written atomically to `<control dir>/.symphony/heartbeat.json`, next to the `logs/` directory. */
export interface OrchestratorHeartbeat {
  version: 1;
  pid: number;
  started_at: string;
  updated_at: string;
  mode: 'config' | 'workflow';
  source_path: string;
  polling_interval_ms: number;
  max_concurrent_agents: number;
  repo_ids: string[];
  shutting_down: boolean;
}

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export type HealthLevel = 'ok' | 'warn' | 'bad' | 'unknown';

export type TaskKind = 'issue' | 'pr' | 'grooming' | 'loop' | 'epic';

/**
 * Operator-facing lifecycle, derived from run state + labels. One per task.
 * `running` covers preparing/agent-running/finalizing.
 */
export type TaskLifecycle =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'needs-info'
  | 'blocked'
  | 'review-blocked'
  | 'review-error'
  | 'ready-for-review'
  | 'waiting-human'
  | 'failed'
  | 'cancelled'
  | 'closed';

export interface ArtifactPaths {
  prompt: string | null;
  agent_log: string | null;
  agent_stderr: string | null;
  last_message: string | null;
  verification: string | null;
  manifest: string | null;
}

export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  turns: number;
}

export interface SourceInfo {
  kind: 'workflow' | 'config';
  path: string;
}

/** Route key for a task: `${repo_id}/${issue_number}` or `${repo_id}/loop/${loop_id}`. */
export type TaskKey = string;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface OrchestratorHealth {
  /** True when the orchestrator heartbeat was updated within 2x the polling interval. */
  alive: boolean;
  level: HealthLevel;
  pid: number | null;
  started_at: string | null;
  last_heartbeat_at: string | null;
  heartbeat_age_ms: number | null;
  polling_interval_ms: number | null;
  max_concurrent_agents: number | null;
  running_agents: number;
  shutting_down: boolean;
  /** Human-readable explanation when not ok (e.g. "No heartbeat found" or "Heartbeat is 23m old"). */
  message: string | null;
}

export type RepoFlagKind =
  | 'dispatch_deferred'
  | 'protected_workspaces'
  | 'provider_backoff'
  | 'github_backoff'
  | 'storage_blocked'
  | 'tick_error'
  | 'stale_poll'
  | 'no_heartbeat'
  | 'retry_exhausted'
  | 'loop_failed'
  | 'pool_exhausted';

export interface RepoHealthFlag {
  kind: RepoFlagKind;
  level: HealthLevel;
  message: string;
  count: number | null;
  since: string | null;
}

export interface RepoCounts {
  queued: number;
  preparing: number;
  running: number;
  retrying: number;
  needs_info: number;
  waiting_human: number;
  review_blocked: number;
  failed: number;
  epics_coordinating: number;
  loops: number;
}

export interface PoolSummary {
  slots_total: number;
  slots_max: number | null;
  slots_in_use: number;
  slots_protected: number;
  slots_idle: number;
}

export interface RepoSummary {
  repo_id: string;
  owner: string | null;
  repo: string | null;
  workflow_path: string;
  workspace_root: string;
  enabled: boolean;
  level: HealthLevel;
  last_poll_at: string | null;
  poll_age_ms: number | null;
  capacity: {
    max_concurrent_agents: number;
    running: number;
    remaining: number | null;
  };
  counts: RepoCounts;
  pool: PoolSummary;
  flags: RepoHealthFlag[];
}

export interface RunningTask {
  task_key: TaskKey;
  kind: TaskKind;
  repo_id: string;
  issue_number: number | null;
  issue_identifier: string;
  issue_url: string | null;
  loop_id: string | null;
  title: string | null;
  status: RunStatus;
  agent_provider: string | null;
  agent_mode: AgentMode | null;
  attempt: number;
  session_id: string | null;
  started_at: string | null;
  elapsed_ms: number | null;
  /** Last line/message the agent produced, trimmed to ~200 chars. */
  last_activity: string | null;
  last_activity_at: string | null;
  usage: TokenUsage | null;
  pr_number: number | null;
  pr_url: string | null;
  workspace_path: string;
  artifacts: ArtifactPaths;
}

export type AttentionReason =
  | 'orchestrator_down'
  | 'needs_info'
  | 'loop_question'
  | 'waiting_human'
  | 'ready_for_review'
  | 'review_blocked'
  | 'review_error'
  | 'retry_exhausted'
  | 'failed'
  | 'loop_failed'
  | 'protected_workspace'
  | 'dispatch_deferred'
  | 'pool_exhausted'
  | 'merge_blocked'
  | 'provider_backoff'
  | 'github_backoff'
  | 'storage_blocked'
  | 'stale_run';

export interface AttentionItem {
  id: string;
  reason: AttentionReason;
  level: HealthLevel;
  repo_id: string | null;
  task_key: TaskKey | null;
  title: string;
  detail: string | null;
  issue_number: number | null;
  issue_url: string | null;
  pr_number: number | null;
  pr_url: string | null;
  workspace_path: string | null;
  since: string | null;
}

export interface EpicChildSummary {
  issue_number: number | null;
  issue_identifier: string;
  issue_url: string | null;
  title: string;
  state: string;
  queued: boolean;
  skipped_reason: string | null;
  lifecycle: TaskLifecycle | null;
}

export interface EpicSummary {
  task_key: TaskKey;
  repo_id: string;
  issue_number: number | null;
  issue_identifier: string;
  issue_url: string | null;
  title: string;
  status: 'coordinating' | 'completed';
  open_children: number;
  terminal_children: number;
  total_children: number;
  updated_at: string;
  children: EpicChildSummary[];
}

export interface OverviewTotals {
  repos: number;
  running: number;
  queued: number;
  retrying: number;
  attention: number;
  attention_bad: number;
}

export interface OverviewState {
  generated_at: string;
  source: SourceInfo;
  orchestrator: OrchestratorHealth;
  totals: OverviewTotals;
  attention: AttentionItem[];
  running: RunningTask[];
  repos: RepoSummary[];
  /** Coordinating epics only; completed epics are available through the task API. */
  epics: EpicSummary[];
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export type SlotState =
  | 'running'
  | 'preparing'
  | 'reserved'
  | 'paused'
  | 'retry-wait'
  | 'protected'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'unknown';

export interface WorkspaceSlot {
  name: string;
  path: string;
  kind: 'pool' | 'dedicated' | 'loop';
  state: SlotState;
  task_key: TaskKey | null;
  issue_number: number | null;
  issue_url: string | null;
  title: string | null;
  agent_provider: string | null;
  agent_mode: AgentMode | null;
  attempt: number | null;
  updated_at: string | null;
  last_error: string | null;
  protected_reason: string | null;
}

export interface RetryEntry {
  task_key: TaskKey;
  issue_number: number;
  issue_identifier: string;
  attempt: number;
  reason: string;
  next_run_at: string;
  mode: string;
  workspace_path: string | null;
  /** True when preparation (checkout/install) failed rather than the agent. */
  setup_failure: boolean;
}

export interface LoopSummary {
  task_key: TaskKey;
  repo_id: string;
  loop_id: string;
  status: RunStatus | 'never-run';
  enabled: boolean;
  interval_ms: number | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  next_due_at: string | null;
  last_outcome: string | null;
  attempt: number | null;
  pause_reason: string | null;
  last_error: string | null;
  workspace_path: string;
  artifacts: ArtifactPaths;
}

export interface PullRequestSummary {
  repo_id: string;
  number: number;
  url: string | null;
  title: string | null;
  head_ref: string | null;
  issue_number: number | null;
  task_key: TaskKey | null;
  review_labels: string[];
  review_claim_status: string | null;
  feedback_round: number | null;
  max_feedback_rounds: number | null;
  merge_blocked_reasons: string[];
  last_merge_assessment_at: string | null;
  updated_at: string | null;
}

export interface TaskSummary {
  task_key: TaskKey;
  kind: TaskKind;
  lifecycle: TaskLifecycle;
  repo_id: string;
  issue_number: number | null;
  issue_identifier: string;
  issue_url: string | null;
  loop_id: string | null;
  title: string | null;
  status: string;
  labels: string[];
  feature_labels: string[];
  agent_provider: string | null;
  agent_mode: AgentMode | null;
  attempt: number | null;
  pr_number: number | null;
  pr_url: string | null;
  updated_at: string;
  last_error: string | null;
  retry_not_before: string | null;
  retry_reason: string | null;
  pause_reason: string | null;
  workspace_path: string | null;
  /** True only for running/preparing tasks whose state has not changed for longer than stale_after_ms. */
  stale: boolean;
  epic_progress: string | null;
}

export interface EpisodeEventSummary {
  sequence: number;
  repo_id: string;
  episode_id: string;
  event: string;
  created_at: string;
  level: HealthLevel;
  /** One line, human readable, derived from event + payload. */
  summary: string;
  issue_number: number | null;
  pr_number: number | null;
  task_key: TaskKey | null;
  payload: Record<string, unknown>;
  /** Added by API: identical events collapsed into this entry (sequence/created_at/payload are the newest). */
  repeat_count?: number;
  /** Added by API: created_at of the oldest collapsed event, when repeat_count > 1. */
  first_at?: string;
}

export interface RepoState extends RepoSummary {
  generated_at: string;
  heartbeat: RepoHeartbeat | null;
  tasks: TaskSummary[];
  slots: WorkspaceSlot[];
  retry_queue: RetryEntry[];
  loops: LoopSummary[];
  pull_requests: PullRequestSummary[];
  epics: EpicSummary[];
  recent_events: EpisodeEventSummary[];
}

// ---------------------------------------------------------------------------
// Task detail
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  at: string;
  event: string;
  kind: 'run' | 'workflow' | 'agent' | 'pr' | 'merge' | 'verification' | 'retry' | 'repair' | 'loop' | 'issue' | 'other';
  level: HealthLevel;
  summary: string;
  payload: Record<string, unknown>;
  /** Added by API: consecutive identical events (same event + reason) collapsed into this entry; `at` is the latest. */
  repeat_count?: number;
  /** Added by API: timestamp of the first collapsed repeat, when repeat_count > 1. */
  first_at?: string;
}

export interface SessionSummary {
  session_id: string;
  attempt: number | null;
  mode: string | null;
  provider: string | null;
  created_at: string | null;
  finished_at: string | null;
  phase: string | null;
  agent_outcome: string | null;
  workflow_outcome: string | null;
  artifact_dir: string;
  artifacts: ArtifactPaths;
  usage: TokenUsage | null;
}

export interface GroomingSummary {
  outcome: string | null;
  summary: string | null;
  scope: string | null;
  raw: Record<string, unknown>;
}

export interface TaskCommands {
  cd: string | null;
  resume: string | null;
  exec: string | null;
  editor_url: string | null;
}

export interface TaskDetail {
  generated_at: string;
  task: TaskSummary;
  run_state: RunState | null;
  timeline: TimelineEntry[];
  sessions: SessionSummary[];
  artifacts: ArtifactPaths;
  grooming: GroomingSummary | null;
  verification: Record<string, unknown> | null;
  pull_request: PullRequestSummary | null;
  epic: EpicSummary | null;
  loop: LoopSummary | null;
  commands: TaskCommands;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface WeeklyStats {
  week_start: string;
  merged: number;
  completed: number;
  failed: number;
  paused: number;
  retries: number;
  loops_completed: number;
  loops_failed: number;
  median_claim_to_merge_ms: number | null;
}

export interface ReasonCount {
  reason: string;
  count: number;
}

export interface RepoHistory {
  repo_id: string;
  weeks: WeeklyStats[];
  top_retry_reasons: ReasonCount[];
  top_failure_reasons: ReasonCount[];
  top_merge_block_reasons: ReasonCount[];
}

export interface HistoryState {
  generated_at: string;
  window: { from: string; to: string; days: number };
  repos: RepoHistory[];
}

export interface EventsPage {
  generated_at: string;
  events: EpisodeEventSummary[];
  /** Pass as `before` to fetch the next (older) page; null when exhausted. */
  next_before: number | string | null;
}

// ---------------------------------------------------------------------------
// Artifacts and agent logs
// ---------------------------------------------------------------------------

export interface ArtifactChunk {
  path: string;
  size: number;
  offset: number;
  next_offset: number;
  content: string;
  truncated: boolean;
  kind: 'text' | 'jsonl' | 'json' | 'markdown';
  mtime: string | null;
}

export interface AgentLogItem {
  index: number;
  at: string | null;
  kind: 'thread' | 'turn' | 'message' | 'reasoning' | 'command' | 'tool' | 'error' | 'raw';
  title: string;
  body: string | null;
  status: 'in_progress' | 'completed' | 'failed' | null;
  exit_code: number | null;
}

export interface AgentLogPage {
  path: string;
  provider_format: 'codex-jsonl' | 'claude-jsonl' | 'plain';
  items: AgentLogItem[];
  /** Pass as `after` to continue; equals the byte offset consumed so far. */
  next_offset: number;
  size: number;
  usage: TokenUsage | null;
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

/** Server-sent event payload on `/api/stream` (event name `change`). */
export interface ChangeEvent {
  at: string;
  scope: 'local' | 'github' | 'heartbeat';
  repo_id: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
}
