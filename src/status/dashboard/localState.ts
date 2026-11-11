import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { EpisodeEvent, MergeAssessmentRecord, RetryRecord, ReviewClaim } from '../../episodes/episodeStore.js';
import { readLoopState } from '../../loops/state.js';
import type { ScheduledLoopConfig } from '../../workflow/types.js';
import { preparationAlive, readPreparation } from '../../workspace/preparation.js';
import { classifyRunState } from '../boardState.js';
import type {
  ArtifactPaths,
  EpicChildSummary,
  EpicSummary,
  HealthLevel,
  LoopSummary,
  PoolSummary,
  RepoCounts,
  RepoHealthFlag,
  RepoHeartbeat,
  RepoSummary,
  RetryEntry,
  SlotState,
  TaskKey,
  TaskKind,
  TaskLifecycle,
  TaskSummary,
  WorkspaceSlot,
} from '../dashboardTypes.js';
import { readEpicStates, type EpicState } from '../epicState.js';
import { readRunState, type RunState } from '../runState.js';
import { readRepoHeartbeat } from '../heartbeat.js';
import { EpisodeReader, numberField } from './episodeReader.js';
import type { GithubIssueMeta, GithubRepoSnapshot } from './githubCache.js';
import type { RepoLogFallback } from './logFallback.js';
import type { DashboardRepoSource } from './sources.js';

export const DEFAULT_STALE_AFTER_MS = 30 * 60_000;

export interface LocalStateOptions {
  now?: Date;
  staleAfterMs?: number;
  github?: GithubRepoSnapshot | null;
  /**
   * Called once local state is read with the issue numbers worth enriching; returns the GitHub
   * snapshot to apply (typically `DashboardGithubCache.ensure`). Takes precedence over `github`.
   */
  resolveGithub?: (issueNumbers: number[]) => Promise<GithubRepoSnapshot | null>;
  /** Orchestrator polling interval, used to judge whether the repo's last poll is stale. */
  pollingIntervalMs?: number | null;
  /** Log-derived state, consulted only when the repo heartbeat is missing. */
  logFallback?: () => Promise<RepoLogFallback | null>;
}

export interface StorageStatus {
  blocked: boolean;
  minimum_free_gib: number | null;
  free_gib?: number | null;
  [key: string]: unknown;
}

export interface RepoLocalState {
  source: DashboardRepoSource;
  generated_at: string;
  heartbeat: RepoHeartbeat | null;
  dispatch_deferrals: RepoHeartbeat['dispatch_deferrals'];
  /** GitHub snapshot applied to this state (null when GitHub enrichment is off). */
  github: GithubRepoSnapshot | null;
  /** Issue/PR run states (preparation lease wins over run.json, as `scanRunStates` does). */
  runs: RunState[];
  loop_runs: Map<string, RunState>;
  epic_states: EpicState[];
  storage_status: StorageStatus | null;
  storage_maintenance: Record<string, unknown> | null;
  retry_records: RetryRecord[];
  review_claims: ReviewClaim[];
  merge_assessments: MergeAssessmentRecord[];
  /** Latest `merge.blocked` / `merge.merged` per PR number. */
  merge_events: Map<number, EpisodeEvent>;
  /** Latest `pr.feedback_*` per PR number. */
  feedback_events: Map<number, EpisodeEvent>;
  /** PR number → originating issue number. */
  pr_to_issue: Map<number, number>;
  tasks: TaskSummary[];
  /** Run states folded into each task, preferred (displayed) state first. */
  task_runs: Map<TaskKey, RunState[]>;
  slots: WorkspaceSlot[];
  retry_queue: RetryEntry[];
  loops: LoopSummary[];
  epics: EpicSummary[];
  summary: RepoSummary;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<HealthLevel, number> = { bad: 3, warn: 2, unknown: 1, ok: 0 };

export function worstLevel(levels: HealthLevel[]): HealthLevel {
  return levels.reduce<HealthLevel>((worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst), 'ok');
}

export function levelRank(level: HealthLevel): number {
  return LEVEL_RANK[level];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function normalizeLabels(labels: string[] | null | undefined): string[] {
  return [...new Set((labels ?? []).map((label) => label.trim().toLowerCase()).filter(Boolean))].sort();
}

const SYSTEM_LABELS = new Set([
  'agent-running',
  'blocked',
  'codex',
  'completed',
  'interactive',
  'needs-info',
  'open',
  'planning',
  'ready-for-agent',
  'ready-for-human',
  'requires-grooming',
  'symphony-failed',
  'task:spec',
  'wontfix',
  'epic',
]);
const SYSTEM_LABEL_PREFIXES = ['symphony-review:', 'agent:', 'epic:', 'priority:', 'priority: ', 'complexity:', 'status:'];

export function featureLabels(labels: string[]): string[] {
  return labels.filter((label) => !SYSTEM_LABELS.has(label) && !SYSTEM_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix)));
}

export function issueNumberFromPullRequestBody(body: string | null): number | null {
  if (!body) return null;
  const match = /(?:^|[^A-Za-z])(?:Fixes|Closes|Resolves)\s+#(\d+)(?:[^0-9]|$)/i.exec(body);
  return match ? Number(match[1]) : null;
}

export function artifactPathsFor(state: RunState | null): ArtifactPaths {
  if (!state) return { prompt: null, agent_log: null, agent_stderr: null, last_message: null, verification: null, manifest: null };
  const dir = state.session_artifact_dir ?? null;
  return {
    prompt: state.prompt_path ?? null,
    agent_log: state.agent_log_path ?? state.agent_output_path ?? state.codex_jsonl_path ?? null,
    agent_stderr: dir ? path.join(dir, 'agent.stderr.log') : null,
    last_message: state.last_message_path ?? null,
    verification: dir ? path.join(dir, 'verification.json') : path.join(state.workspace_path, '.symphony', 'verification.json'),
    manifest: dir ? path.join(dir, 'manifest.json') : null,
  };
}

export function taskKeyForIssue(repoId: string, issue: number | string): TaskKey {
  return `${repoId}/${issue}`;
}

export function taskKeyForLoop(repoId: string, loopId: string): TaskKey {
  return `${repoId}/loop/${loopId}`;
}

export function isRunningStatus(status: string): boolean {
  return status === 'preparing' || status === 'agent-running' || status === 'finalizing';
}

/** Maps a run state to the operator lifecycle using the board's column classification. */
export function lifecycleFor(state: RunState, terminalStates: string[]): TaskLifecycle {
  const column = classifyRunState(state, terminalStates);
  if (column === 'closed') return 'closed';
  if (state.status === 'retry-wait') return 'retrying';
  switch (column) {
    case 'active':
      return 'running';
    case 'failed-cancelled':
      return state.status === 'cancelled' ? 'cancelled' : 'failed';
    default:
      return column;
  }
}

const LIFECYCLE_PRIORITY: TaskLifecycle[] = [
  'running',
  'retrying',
  'needs-info',
  'blocked',
  'review-blocked',
  'review-error',
  'ready-for-review',
  'waiting-human',
  'queued',
  'closed',
  'failed',
  'cancelled',
];

function lifecycleRank(lifecycle: TaskLifecycle): number {
  return LIFECYCLE_PRIORITY.indexOf(lifecycle);
}

function withGithub(state: RunState, meta: GithubIssueMeta | undefined): RunState {
  if (!meta) return state;
  return {
    ...state,
    issue_identifier: meta.identifier,
    issue_url: meta.url,
    issue_title: meta.title,
    issue_state: meta.state,
    labels: meta.labels,
    workflow_state: meta.workflow_state,
    pause_reason: state.pause_reason === 'needs-info' && meta.labels.includes('ready-for-agent') && !meta.labels.includes('needs-info')
      ? null : state.pause_reason,
  };
}

function isStale(lifecycle: TaskLifecycle, updatedAt: string, now: Date, staleAfterMs: number): boolean {
  if (lifecycle !== 'running') return false;
  const updatedMs = Date.parse(updatedAt);
  return Number.isFinite(updatedMs) && now.getTime() - updatedMs > staleAfterMs;
}

function kindFor(state: RunState, isPullRequest: boolean): TaskKind {
  if (state.loop_id) return 'loop';
  const mode = state.agent_mode ?? state.codex_mode ?? null;
  if (mode === 'grooming') return 'grooming';
  if (isPullRequest || mode === 'pr-review' || mode === 'resolve-conflicts') return 'pr';
  return 'issue';
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

interface SlotRead {
  name: string;
  path: string;
  kind: WorkspaceSlot['kind'];
  run: RunState | null;
  lease: RunState | null;
  leaseAlive: boolean;
}

function slotKind(name: string): WorkspaceSlot['kind'] | null {
  if (/^_pool_\d+$/.test(name)) return 'pool';
  if (name.startsWith('_') || name.startsWith('.')) return null;
  return 'dedicated';
}

async function readSlot(name: string, slotPath: string, kind: WorkspaceSlot['kind']): Promise<SlotRead> {
  const [run, lease] = await Promise.all([
    readRunState(slotPath),
    kind === 'loop' ? Promise.resolve(null) : readPreparation(slotPath).catch(() => null),
  ]);
  return { name, path: slotPath, kind, run, lease, leaseAlive: lease ? preparationAlive(lease) : false };
}

async function readSlots(workspaceRoot: string): Promise<SlotRead[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const reads: Array<Promise<SlotRead>> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const kind = slotKind(entry.name);
    if (kind) reads.push(readSlot(entry.name, path.join(workspaceRoot, entry.name), kind));
  }
  const loopsDir = path.join(workspaceRoot, '_loops');
  const loopEntries = await fs.readdir(loopsDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  for (const entry of loopEntries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) reads.push(readSlot(`_loops/${entry.name}`, path.join(loopsDir, entry.name), 'loop'));
  }
  return Promise.all(reads);
}

function slotStateFor(slot: SlotRead, protectedReason: string | null): SlotState {
  if (slot.lease && slot.leaseAlive) return 'preparing';
  const status = slot.run?.status ?? null;
  if (status === 'agent-running' || status === 'finalizing') return 'running';
  if (status === 'preparing') return 'preparing';
  if (protectedReason !== null) return 'protected';
  if (slot.lease) return 'reserved';
  switch (status) {
    case null:
      return 'idle';
    case 'paused':
      return 'paused';
    case 'retry-wait':
      return 'retry-wait';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'unknown';
  }
}

const IN_USE_SLOT_STATES = new Set<SlotState>(['running', 'preparing', 'reserved', 'paused', 'retry-wait']);

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

/** A loop with no run.json but a trigger and no outcome this long ago was interrupted. */
const LOOP_TRIGGER_IN_FLIGHT_MS = 60 * 60_000;

function loopSummaryFor(
  repoId: string,
  root: string,
  loop: ScheduledLoopConfig,
  state: RunState | null,
  activity: { triggered: EpisodeEvent | null; outcome: EpisodeEvent | null },
  now: Date,
): LoopSummary {
  const intervalMs = Number.isFinite(loop.interval_ms) && loop.interval_ms > 0 ? loop.interval_ms : null;
  let status: LoopSummary['status'];
  let lastStarted: string | null;
  let lastFinished: string | null;
  let lastOutcome: string | null;
  let lastError: string | null;
  if (state) {
    status = state.status;
    lastStarted = state.loop_run_started_at ?? state.started_at;
    lastFinished = state.finished_at;
    lastOutcome = state.workflow_outcome ?? state.agent_outcome ?? null;
    lastError = state.last_error;
  } else {
    const { triggered, outcome } = activity;
    lastStarted = triggered?.created_at ?? null;
    lastFinished = outcome?.created_at ?? null;
    lastOutcome = outcome ? (outcome.event === 'loop.completed' ? 'completed' : 'failed') : null;
    const payload = outcome?.payload ?? {};
    lastError =
      outcome?.event === 'loop.failed'
        ? [typeof payload.reason === 'string' ? payload.reason : null, typeof payload.error === 'string' ? payload.error : null]
            .filter(Boolean)
            .join(': ') || (typeof payload.exit_code === 'number' ? `exit ${payload.exit_code}` : null)
        : null;
    if (lastOutcome) status = lastOutcome as 'completed' | 'failed';
    else if (triggered) status = now.getTime() - Date.parse(triggered.created_at) < LOOP_TRIGGER_IN_FLIGHT_MS ? 'preparing' : 'cancelled';
    else status = 'never-run';
  }
  // The orchestrator schedules from the latest trigger, falling back to the run's start.
  const lastTrigger = activity.triggered?.created_at ?? lastStarted;
  const lastTriggerMs = lastTrigger ? Date.parse(lastTrigger) : Number.NaN;
  let nextDue: string | null = null;
  if (loop.enabled && intervalMs !== null) {
    nextDue = Number.isFinite(lastTriggerMs) ? new Date(lastTriggerMs + intervalMs).toISOString() : now.toISOString();
    if (state?.status === 'retry-wait' && state.retry_not_before) nextDue = state.retry_not_before;
  }
  return {
    task_key: taskKeyForLoop(repoId, loop.id),
    repo_id: repoId,
    loop_id: loop.id,
    status,
    enabled: loop.enabled,
    interval_ms: intervalMs,
    last_started_at: lastStarted,
    last_finished_at: lastFinished,
    next_due_at: nextDue,
    last_outcome: lastOutcome,
    attempt: state?.attempt ?? null,
    pause_reason: state?.pause_reason ?? null,
    last_error: lastError,
    workspace_path: state?.workspace_path ?? path.join(root, '_loops', loop.id),
    artifacts: artifactPathsFor(state),
  };
}

/** Operator lifecycle for a loop: running, then disabled → closed, failed, paused question, retrying, else queued. */
export function loopLifecycle(loop: LoopSummary): TaskLifecycle {
  if (loop.status !== 'never-run' && isRunningStatus(loop.status)) return 'running';
  if (!loop.enabled) return 'closed';
  if (loop.status === 'failed') return 'failed';
  // A paused loop is waiting on an answer to its question.
  if (loop.status === 'paused') return 'waiting-human';
  if (loop.status === 'retry-wait') return 'retrying';
  return 'queued';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface TaskDraft {
  summary: TaskSummary;
  runs: RunState[];
}

function emptyCounts(): RepoCounts {
  return {
    queued: 0,
    preparing: 0,
    running: 0,
    retrying: 0,
    needs_info: 0,
    waiting_human: 0,
    review_blocked: 0,
    failed: 0,
    epics_coordinating: 0,
    loops: 0,
  };
}

export function isRetryExhausted(task: Pick<TaskSummary, 'attempt' | 'last_error' | 'lifecycle'>, maxAttempts: number | null): boolean {
  if (task.lifecycle !== 'failed') return false;
  if (maxAttempts !== null && task.attempt !== null && task.attempt >= maxAttempts) return true;
  return /exhaust/i.test(task.last_error ?? '');
}

function emptyLocalState(source: DashboardRepoSource, now: Date): RepoLocalState {
  const flags: RepoHealthFlag[] = [
    { kind: 'tick_error', level: 'bad', message: `WORKFLOW.md failed to load: ${source.load_error ?? 'unknown error'}`, count: null, since: null },
  ];
  return {
    source,
    generated_at: now.toISOString(),
    heartbeat: null,
    dispatch_deferrals: [],
    github: null,
    runs: [],
    loop_runs: new Map(),
    epic_states: [],
    storage_status: null,
    storage_maintenance: null,
    retry_records: [],
    review_claims: [],
    merge_assessments: [],
    merge_events: new Map(),
    feedback_events: new Map(),
    pr_to_issue: new Map(),
    tasks: [],
    task_runs: new Map(),
    slots: [],
    retry_queue: [],
    loops: [],
    epics: [],
    summary: {
      repo_id: source.repo_id,
      owner: source.owner,
      repo: source.repo,
      workflow_path: source.workflow_path,
      workspace_root: source.workspace_root ?? '',
      enabled: source.enabled,
      level: 'bad',
      last_poll_at: null,
      poll_age_ms: null,
      capacity: { max_concurrent_agents: source.max_concurrent_agents ?? 0, running: 0, remaining: null },
      counts: emptyCounts(),
      pool: { slots_total: 0, slots_max: null, slots_in_use: 0, slots_protected: 0, slots_idle: 0 },
      flags,
    },
  };
}

/** Reads everything local for one repo (no GitHub calls) and derives the repo read models. */
export async function loadRepoLocalState(source: DashboardRepoSource, options: LocalStateOptions = {}): Promise<RepoLocalState> {
  const now = options.now ?? new Date();
  const config = source.config;
  const root = source.workspace_root;
  if (!config || !root) return emptyLocalState(source, now);
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const repoId = source.repo_id;
  let github = options.github ?? null;
  const metaDir = path.join(root, '.symphony');

  const [slotReads, loopRunList, epicStates, heartbeat, storageStatus, storageMaintenance] = await Promise.all([
    readSlots(root),
    Promise.all(config.loops.map((loop) => readLoopState(config, loop.id).catch(() => null))),
    readEpicStates(root),
    readRepoHeartbeat(root).catch(() => null),
    readJson<StorageStatus>(path.join(metaDir, 'storage-status.json')),
    readJson<Record<string, unknown>>(path.join(metaDir, 'storage-maintenance.json')),
  ]);

  const reader = EpisodeReader.open(root);
  let retryRecords: RetryRecord[] = [];
  let reviewClaims: ReviewClaim[] = [];
  let mergeAssessments: MergeAssessmentRecord[] = [];
  let mergeEvents = new Map<number, EpisodeEvent>();
  let feedbackEvents = new Map<number, EpisodeEvent>();
  const loopActivity = new Map<string, ReturnType<EpisodeReader['loopActivity']>>();
  try {
    retryRecords = reader.retries();
    reviewClaims = reader.reviewClaims();
    mergeAssessments = reader.mergeAssessments();
    mergeEvents = reader.latestMergeEvents();
    feedbackEvents = reader.latestFeedbackEvents();
    for (const loop of config.loops) loopActivity.set(loop.id, reader.loopActivity(loop.id));
  } finally {
    reader.close();
  }
  const loopDirMtimes = new Map<string, string>();
  await Promise.all(
    config.loops.map(async (loop) => {
      const stat = await fs.stat(path.join(root, '_loops', loop.id)).catch(() => null);
      if (stat) loopDirMtimes.set(loop.id, stat.mtime.toISOString());
    }),
  );

  // Runs: same precedence as scanRunStates (a live preparation lease wins over run.json).
  const runs: RunState[] = [];
  for (const slot of slotReads) {
    if (slot.kind === 'loop') continue;
    const state = slot.lease && slot.leaseAlive ? slot.lease : slot.run;
    if (state) runs.push(state);
  }
  const loopRuns = new Map<string, RunState>();
  for (const state of loopRunList) if (state?.loop_id) loopRuns.set(state.loop_id, state);

  if (options.resolveGithub) {
    const numbers = new Set<number>();
    for (const state of runs) if (state.issue_number !== null) numbers.add(state.issue_number);
    for (const epic of epicStates) if (epic.issue_number !== null && epic.status !== 'completed') numbers.add(epic.issue_number);
    github = await options.resolveGithub([...numbers]).catch(() => github);
  }

  // PR → originating issue, from local review context first, then GitHub PR bodies, then merge events.
  const prToIssue = new Map<number, number>();
  for (const state of runs) {
    const review = state.finalization_context?.review_pr;
    if (review?.originating_issue_number && review.pr_number !== review.originating_issue_number) {
      prToIssue.set(review.pr_number, review.originating_issue_number);
    }
  }
  const openPrNumbers = new Set<number>();
  for (const pr of github?.pull_requests ?? []) {
    openPrNumbers.add(pr.number);
    const issue = issueNumberFromPullRequestBody(pr.body);
    if (issue !== null && issue !== pr.number && !prToIssue.has(pr.number)) prToIssue.set(pr.number, issue);
  }
  for (const [pr, event] of mergeEvents) {
    const issue = numberField(event.payload.issue_number);
    if (issue !== null && issue !== pr && !prToIssue.has(pr)) prToIssue.set(pr, issue);
  }
  const prForIssue = new Map<number, number>();
  for (const [pr, issue] of prToIssue) {
    const existing = prForIssue.get(issue);
    if (existing === undefined || pr > existing) prForIssue.set(issue, pr);
  }
  // Web base for PR links when GitHub has not been fetched (works for GitHub Enterprise too).
  const webBase =
    runs.map((run) => /^(https?:\/\/.+)\/(?:issues|pull)\/\d+$/.exec(run.issue_url ?? '')?.[1]).find(Boolean) ??
    `https://github.com/${config.tracker.owner}/${config.tracker.repo}`;
  const prUrl = (pr: number): string | null =>
    github?.pull_requests.find((ref) => ref.number === pr)?.url ?? github?.issues.get(pr)?.url ?? `${webBase}/pull/${pr}`;

  const terminalStates = config.tracker.terminal_states;
  const drafts = new Map<TaskKey, TaskDraft>();
  const addDraft = (draft: TaskDraft) => {
    const existing = drafts.get(draft.summary.task_key);
    if (!existing) {
      drafts.set(draft.summary.task_key, draft);
      return;
    }
    const preferExisting = lifecycleRank(existing.summary.lifecycle) <= lifecycleRank(draft.summary.lifecycle);
    const preferred = preferExisting ? existing : draft;
    const other = preferExisting ? draft : existing;
    const a = preferred.summary;
    const b = other.summary;
    drafts.set(a.task_key, {
      runs: [...preferred.runs, ...other.runs],
      summary: {
        ...a,
        // An issue task stays an issue task even when its PR run is the one being shown.
        kind: a.kind === 'pr' && b.kind !== 'pr' ? b.kind : a.kind,
        issue_number: b.kind !== 'pr' && a.kind === 'pr' ? b.issue_number : a.issue_number,
        issue_identifier: b.kind !== 'pr' && a.kind === 'pr' ? b.issue_identifier : a.issue_identifier,
        issue_url: b.kind !== 'pr' && a.kind === 'pr' ? b.issue_url : a.issue_url,
        title: (b.kind !== 'pr' && a.kind === 'pr' ? b.title : a.title) ?? a.title ?? b.title,
        labels: [...new Set([...a.labels, ...b.labels])].sort(),
        feature_labels: [...new Set([...a.feature_labels, ...b.feature_labels])].sort(),
        pr_number: a.pr_number ?? b.pr_number,
        pr_url: a.pr_url ?? b.pr_url,
        last_error: a.last_error ?? b.last_error,
        workspace_path: a.workspace_path ?? b.workspace_path,
        epic_progress: a.epic_progress ?? b.epic_progress,
        updated_at: a.updated_at >= b.updated_at ? a.updated_at : b.updated_at,
        stale: a.stale,
      },
    });
  };

  for (const local of runs) {
    const state = local.issue_number !== null ? withGithub(local, github?.issues.get(local.issue_number)) : local;
    const isPr = state.issue_number !== null && (prToIssue.has(state.issue_number) || openPrNumbers.has(state.issue_number));
    const parent = state.issue_number !== null ? (prToIssue.get(state.issue_number) ?? state.issue_number) : null;
    const lifecycle = lifecycleFor(state, terminalStates);
    const labels = normalizeLabels(state.labels);
    const prNumber = isPr ? state.issue_number : parent !== null ? (prForIssue.get(parent) ?? null) : null;
    const meta = parent !== null && parent !== state.issue_number ? github?.issues.get(parent) : undefined;
    const kind = kindFor(state, isPr);
    addDraft({
      runs: [local],
      summary: {
        task_key: taskKeyForIssue(repoId, parent ?? state.issue_identifier),
        kind,
        lifecycle,
        repo_id: repoId,
        issue_number: parent,
        issue_identifier: meta?.identifier ?? (isPr && parent !== null ? `${config.tracker.owner}/${config.tracker.repo}#${parent}` : state.issue_identifier),
        issue_url: meta?.url ?? (isPr ? null : state.issue_url),
        loop_id: null,
        title: meta?.title ?? state.issue_title ?? null,
        status: state.status,
        labels,
        feature_labels: featureLabels(labels),
        agent_provider: state.agent_provider ?? null,
        agent_mode: state.agent_mode ?? state.codex_mode ?? null,
        attempt: state.attempt,
        pr_number: prNumber,
        pr_url: isPr ? (state.issue_url ?? (prNumber !== null ? prUrl(prNumber) : null)) : prNumber !== null ? prUrl(prNumber) : null,
        updated_at: state.updated_at,
        last_error: state.last_error,
        retry_not_before: state.retry_not_before ?? null,
        retry_reason: state.retry_reason ?? null,
        pause_reason: state.pause_reason ?? null,
        workspace_path: state.workspace_path,
        stale: isStale(lifecycle, local.updated_at, now, staleAfterMs),
        epic_progress: null,
      },
    });
  }

  // Loops: run state when present, otherwise derived from loop episodes (run.json may be cleaned).
  const loops: LoopSummary[] = config.loops.map((loop) =>
    loopSummaryFor(repoId, root, loop, loopRuns.get(loop.id) ?? null, loopActivity.get(loop.id) ?? { triggered: null, outcome: null }, now),
  );
  for (const loop of loops) {
    const state = loopRuns.get(loop.loop_id) ?? null;
    const lifecycle = loopLifecycle(loop);
    const updatedAt =
      [state?.updated_at, loop.last_started_at, loop.last_finished_at]
        .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
        .sort()
        .pop() ??
      loopDirMtimes.get(loop.loop_id) ??
      now.toISOString();
    addDraft({
      runs: state ? [state] : [],
      summary: {
        task_key: loop.task_key,
        kind: 'loop',
        lifecycle,
        repo_id: repoId,
        issue_number: null,
        issue_identifier: state?.issue_identifier ?? `${config.tracker.owner}/${config.tracker.repo}#loop-${loop.loop_id}`,
        issue_url: null,
        loop_id: loop.loop_id,
        title: `Loop: ${loop.loop_id}`,
        status: loop.status,
        labels: [],
        feature_labels: [],
        agent_provider: state?.agent_provider ?? null,
        agent_mode: state?.agent_mode ?? state?.codex_mode ?? null,
        attempt: loop.attempt,
        pr_number: null,
        pr_url: null,
        updated_at: updatedAt,
        last_error: loop.last_error,
        retry_not_before: state?.retry_not_before ?? null,
        retry_reason: state?.retry_reason ?? null,
        pause_reason: loop.pause_reason,
        workspace_path: loop.workspace_path,
        stale: state ? isStale(lifecycle, state.updated_at, now, staleAfterMs) : false,
        epic_progress: null,
      },
    });
  }

  // Epics (GitHub can close a coordinating epic).
  const epicStatesResolved = epicStates.map((epic) => {
    const meta = epic.issue_number !== null ? github?.issues.get(epic.issue_number) : undefined;
    if (!meta || epic.status === 'completed') return epic;
    const terminal = new Set(terminalStates.map((value) => value.trim().toLowerCase()));
    return {
      ...epic,
      title: meta.title,
      labels: meta.labels,
      issue_url: meta.url ?? epic.issue_url,
      status: terminal.has(meta.state.trim().toLowerCase()) ? ('completed' as const) : epic.status,
    };
  });
  for (const epic of epicStatesResolved) {
    const labels = normalizeLabels(epic.labels);
    const completed = epic.status === 'completed';
    addDraft({
      runs: [],
      summary: {
        task_key: taskKeyForIssue(repoId, epic.issue_number ?? epic.issue_identifier),
        kind: 'epic',
        lifecycle: completed ? 'closed' : 'running',
        repo_id: repoId,
        issue_number: epic.issue_number,
        issue_identifier: epic.issue_identifier,
        issue_url: epic.issue_url,
        loop_id: null,
        title: epic.title,
        status: `epic:${epic.status}`,
        labels,
        feature_labels: featureLabels(labels),
        agent_provider: null,
        agent_mode: null,
        attempt: null,
        pr_number: null,
        pr_url: null,
        updated_at: epic.updated_at,
        last_error: null,
        retry_not_before: null,
        retry_reason: null,
        pause_reason: null,
        workspace_path: null,
        stale: false,
        epic_progress: `${epic.terminal_children}/${epic.total_children}`,
      },
    });
  }

  const tasks = [...drafts.values()].map((draft) => draft.summary);
  tasks.sort((a, b) => lifecycleRank(a.lifecycle) - lifecycleRank(b.lifecycle) || b.updated_at.localeCompare(a.updated_at));
  const taskRuns = new Map([...drafts.values()].map((draft) => [draft.summary.task_key, draft.runs]));
  const taskByIssue = new Map<number, TaskSummary>();
  for (const task of tasks) if (task.issue_number !== null && task.kind !== 'loop') taskByIssue.set(task.issue_number, task);

  const epics: EpicSummary[] = epicStatesResolved.map((epic) => ({
    task_key: taskKeyForIssue(repoId, epic.issue_number ?? epic.issue_identifier),
    repo_id: repoId,
    issue_number: epic.issue_number,
    issue_identifier: epic.issue_identifier,
    issue_url: epic.issue_url,
    title: epic.title,
    status: epic.status,
    open_children: epic.open_children,
    terminal_children: epic.terminal_children,
    total_children: epic.total_children,
    updated_at: epic.updated_at,
    children: epic.children.map(
      (child): EpicChildSummary => ({
        issue_number: child.issue_number,
        issue_identifier: child.issue_identifier,
        issue_url: child.issue_url,
        title: github?.issues.get(child.issue_number ?? -1)?.title ?? child.title,
        state: github?.issues.get(child.issue_number ?? -1)?.state ?? child.state,
        queued: child.queued,
        skipped_reason: child.skipped_reason,
        lifecycle: child.issue_number !== null ? (taskByIssue.get(child.issue_number)?.lifecycle ?? null) : null,
      }),
    ),
  }));

  // Slots.
  const logFallback = heartbeat || !options.logFallback ? null : await options.logFallback().catch(() => null);
  const protectedList = heartbeat?.protected_workspaces ?? logFallback?.protected_workspaces ?? [];
  const protectedByPath = new Map(protectedList.map((entry) => [path.resolve(entry.path), entry.reason]));
  const slots: WorkspaceSlot[] = slotReads
    .map((slot): WorkspaceSlot => {
      const state = slot.lease && slot.leaseAlive ? slot.lease : (slot.run ?? slot.lease);
      const protectedReason = protectedByPath.get(path.resolve(slot.path)) ?? null;
      const issueNumber = state?.issue_number ?? null;
      const parent = issueNumber !== null ? (prToIssue.get(issueNumber) ?? issueNumber) : null;
      const taskKey = state?.loop_id ? taskKeyForLoop(repoId, state.loop_id) : parent !== null ? taskKeyForIssue(repoId, parent) : null;
      return {
        name: slot.name,
        path: slot.path,
        kind: slot.kind,
        state: slotStateFor(slot, protectedReason),
        task_key: taskKey,
        issue_number: issueNumber,
        issue_url: state?.issue_url ?? null,
        title: state?.loop_id ? `Loop: ${state.loop_id}` : (github?.issues.get(issueNumber ?? -1)?.title ?? state?.issue_title ?? null),
        agent_provider: state?.agent_provider ?? null,
        agent_mode: state?.agent_mode ?? state?.codex_mode ?? null,
        attempt: state?.attempt ?? null,
        updated_at: state?.updated_at ?? null,
        last_error: state?.last_error ?? null,
        protected_reason: protectedReason,
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  const poolSlots = slots.filter((slot) => slot.kind === 'pool');
  const pool: PoolSummary = {
    slots_total: poolSlots.length,
    slots_max: config.workspace.storage_maintenance?.max_pool_slots ?? null,
    slots_in_use: poolSlots.filter((slot) => IN_USE_SLOT_STATES.has(slot.state)).length,
    slots_protected: poolSlots.filter((slot) => slot.state === 'protected').length,
    slots_idle: poolSlots.filter((slot) => !IN_USE_SLOT_STATES.has(slot.state) && slot.state !== 'protected').length,
  };

  // Retry queue.
  const retryQueue: RetryEntry[] = retryRecords.map((record) => {
    const parent = prToIssue.get(record.issue_number) ?? record.issue_number;
    return {
      task_key: taskKeyForIssue(repoId, parent),
      issue_number: record.issue_number,
      issue_identifier: record.issue_identifier,
      attempt: record.attempt,
      reason: record.reason,
      next_run_at: record.next_run_at,
      mode: record.mode,
      workspace_path: record.workspace_path,
      setup_failure: /^(preparation|setup|workspace|hook)/i.test(record.reason) || /preparation_error|before_run|after_create/i.test(record.reason),
    };
  });

  // Counts.
  const counts = emptyCounts();
  counts.loops = config.loops.length;
  counts.epics_coordinating = epics.filter((epic) => epic.status === 'coordinating').length;
  for (const task of tasks) {
    if (task.kind === 'epic') continue;
    if (task.status === 'preparing') counts.preparing += 1;
    else if (task.status === 'agent-running' || task.status === 'finalizing') counts.running += 1;
    switch (task.lifecycle) {
      case 'queued':
        // An idle loop waiting for its next interval is not queued work.
        if (task.kind !== 'loop') counts.queued += 1;
        break;
      case 'retrying':
        counts.retrying += 1;
        break;
      case 'needs-info':
        counts.needs_info += 1;
        break;
      case 'waiting-human':
        counts.waiting_human += 1;
        break;
      case 'review-blocked':
      case 'review-error':
        counts.review_blocked += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      default:
        break;
    }
  }

  // Flags.
  const flags: RepoHealthFlag[] = [];
  const nowMs = now.getTime();
  const pollInterval = options.pollingIntervalMs ?? config.polling.interval_ms ?? null;
  const lastPollAt = heartbeat ? (heartbeat.tick_finished_at ?? heartbeat.tick_started_at) : (logFallback?.last_poll_at ?? null);
  const pollAgeMs = lastPollAt && Number.isFinite(Date.parse(lastPollAt)) ? Math.max(0, nowMs - Date.parse(lastPollAt)) : null;
  if (!heartbeat) {
    flags.push({
      kind: 'no_heartbeat',
      level: 'warn',
      message: logFallback?.last_poll_at ? 'No repo heartbeat; poll time taken from logs' : 'No repo heartbeat found',
      count: null,
      since: null,
    });
  }
  if (pollAgeMs !== null && pollInterval) {
    const staleAfter = Math.max(3 * pollInterval, 10 * 60_000);
    if (pollAgeMs > staleAfter) {
      flags.push({ kind: 'stale_poll', level: 'warn', message: `Last poll was ${Math.round(pollAgeMs / 60_000)}m ago`, count: null, since: lastPollAt });
    }
  }
  if (heartbeat?.tick_outcome === 'error') {
    flags.push({ kind: 'tick_error', level: 'bad', message: heartbeat.tick_error ?? 'Last tick failed', count: null, since: heartbeat.tick_started_at });
  } else if (heartbeat?.tick_outcome === 'skipped' && heartbeat.tick_skip_reason && /failed/.test(heartbeat.tick_skip_reason)) {
    flags.push({ kind: 'tick_error', level: 'warn', message: `Last tick skipped: ${heartbeat.tick_skip_reason}`, count: null, since: heartbeat.tick_started_at });
  }
  if (heartbeat?.workflow_load_error) {
    flags.push({ kind: 'tick_error', level: 'warn', message: `WORKFLOW.md error (running on last good config): ${heartbeat.workflow_load_error}`, count: null, since: heartbeat.tick_started_at });
  }
  const deferrals = (heartbeat?.dispatch_deferrals ?? []).filter((entry) =>
    !runs.some((run) => entry.issue_number !== null && run.issue_number === entry.issue_number &&
      (run.status === 'agent-running' || run.status === 'finalizing' || run.status === 'completed') &&
      Date.parse(run.started_at ?? '') >= Date.parse(entry.at)));
  if (deferrals.length > 0) {
    const reasons = [...new Set(deferrals.map((entry) => entry.reason))];
    flags.push({
      kind: 'dispatch_deferred',
      level: 'warn',
      message: `Dispatch deferred: ${reasons.join('; ')}`,
      count: deferrals.length,
      since: deferrals.map((entry) => entry.at).sort()[0] ?? null,
    });
  }
  if (protectedList.length > 0) {
    flags.push({
      kind: 'protected_workspaces',
      level: 'warn',
      message: `${protectedList.length} workspace${protectedList.length === 1 ? '' : 's'} preserved with protected work`,
      count: protectedList.length,
      since: null,
    });
  }
  const providerBackoff = (heartbeat?.provider_backoff ?? []).filter((entry) => Date.parse(entry.until) > nowMs);
  if (providerBackoff.length > 0) {
    flags.push({
      kind: 'provider_backoff',
      level: 'warn',
      message: `Provider backoff: ${providerBackoff.map((entry) => `${entry.provider} until ${entry.until}`).join(', ')}`,
      count: providerBackoff.length,
      since: null,
    });
  }
  const githubBackoffUntil = [heartbeat?.github_rate_limit_backoff_until, github?.backoff_until]
    .filter((value): value is string => Boolean(value) && Date.parse(value!) > nowMs)
    .sort()
    .pop();
  if (githubBackoffUntil) {
    flags.push({ kind: 'github_backoff', level: 'warn', message: `GitHub rate limit backoff until ${githubBackoffUntil}`, count: null, since: null });
  } else if (github?.last_error) {
    flags.push({ kind: 'github_backoff', level: 'warn', message: `GitHub refresh failed: ${github.last_error}`, count: null, since: github.last_refreshed_at });
  }
  if (storageStatus?.blocked || heartbeat?.storage.blocked) {
    const minFree = heartbeat?.storage.minimum_free_gib ?? storageStatus?.minimum_free_gib ?? null;
    const free = heartbeat?.storage.free_gib ?? (typeof storageStatus?.free_gib === 'number' ? storageStatus.free_gib : null);
    flags.push({
      kind: 'storage_blocked',
      level: 'bad',
      message: `Dispatch blocked on disk space${free !== null ? `: ${free.toFixed(1)} GiB free` : ''}${minFree !== null ? ` (minimum ${minFree} GiB)` : ''}`,
      count: null,
      since: null,
    });
  }
  const exhausted = tasks.filter((task) => isRetryExhausted(task, config.agent.max_attempts ?? null));
  if (exhausted.length > 0) {
    flags.push({ kind: 'retry_exhausted', level: 'bad', message: `${exhausted.length} task${exhausted.length === 1 ? '' : 's'} exhausted retries`, count: exhausted.length, since: null });
  }
  const failedLoops = loops.filter((loop) => loop.status === 'failed');
  if (failedLoops.length > 0) {
    flags.push({ kind: 'loop_failed', level: 'warn', message: `Loop failed: ${failedLoops.map((loop) => loop.loop_id).join(', ')}`, count: failedLoops.length, since: null });
  }
  if (pool.slots_max !== null && pool.slots_total > 0 && pool.slots_in_use >= pool.slots_max) {
    flags.push({ kind: 'pool_exhausted', level: 'warn', message: `All ${pool.slots_max} pool slots in use`, count: pool.slots_in_use, since: null });
  }

  const runningNow = tasks.filter((task) => task.kind !== 'epic' && isRunningStatus(task.status)).length;
  const maxConcurrent = heartbeat?.capacity.max_concurrent_agents ?? source.max_concurrent_agents ?? config.agent.max_concurrent_agents;
  const remaining = heartbeat?.poll?.capacity_remaining ?? logFallback?.capacity_remaining ?? Math.max(0, maxConcurrent - runningNow);

  const summary: RepoSummary = {
    repo_id: repoId,
    owner: config.tracker.owner,
    repo: config.tracker.repo,
    workflow_path: source.workflow_path,
    workspace_root: root,
    enabled: source.enabled,
    level: worstLevel(flags.map((flag) => flag.level)),
    last_poll_at: lastPollAt,
    poll_age_ms: pollAgeMs,
    capacity: { max_concurrent_agents: maxConcurrent, running: runningNow, remaining },
    counts,
    pool,
    flags,
  };

  return {
    source,
    generated_at: now.toISOString(),
    heartbeat,
    dispatch_deferrals: deferrals,
    github,
    runs,
    loop_runs: loopRuns,
    epic_states: epicStatesResolved,
    storage_status: storageStatus,
    storage_maintenance: storageMaintenance,
    retry_records: retryRecords,
    review_claims: reviewClaims,
    merge_assessments: mergeAssessments,
    merge_events: mergeEvents,
    feedback_events: feedbackEvents,
    pr_to_issue: prToIssue,
    tasks,
    task_runs: taskRuns,
    slots,
    retry_queue: retryQueue,
    loops,
    epics,
    summary,
  };
}
