import { lastAgentActivity, readAgentUsage } from '../../dashboard/agentLog.js';
import type { ArtifactAccess } from '../../dashboard/artifacts.js';
import type {
  AttentionItem,
  AttentionReason,
  HealthLevel,
  OrchestratorHealth,
  OrchestratorHeartbeat,
  OverviewState,
  RunningTask,
  TaskSummary,
} from '../dashboardTypes.js';
import { readOrchestratorHeartbeat } from '../heartbeat.js';
import { loadAllLocal, type ReadModelOptions } from './context.js';
import { numberField } from './episodeReader.js';
import { artifactPathsFor, isRetryExhausted, isRunningStatus, levelRank, type RepoLocalState } from './localState.js';
import type { DashboardSources } from './sources.js';

export const MAX_ENRICHED_RUNNING_TASKS = 10;
const ORCHESTRATOR_FALLBACK_ALIVE_MS = 10 * 60_000;
/** Without GitHub's open-PR list, a merge block older than this is assumed resolved. */
const MERGE_BLOCK_LOCAL_WINDOW_MS = 24 * 60 * 60_000;

// Live filesystem notifications can arrive much faster than a full usage scan should run.
const usageSnapshots = new Map<string, { expires: number; usage: ReturnType<typeof readAgentUsage> }>();

function overviewAgentUsage(access: ArtifactAccess, log: string): ReturnType<typeof readAgentUsage> {
  const now = Date.now();
  const key = JSON.stringify([access.allowedRoots, log]);
  const cached = usageSnapshots.get(key);
  if (cached && cached.expires > now) return cached.usage;
  const usage = readAgentUsage(access, log).catch(() => null);
  usageSnapshots.delete(key);
  usageSnapshots.set(key, { expires: now + 30_000, usage });
  if (usageSnapshots.size > 100) usageSnapshots.delete(usageSnapshots.keys().next().value!);
  return usage;
}

function processAlive(pid: number): boolean | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? true : false;
  }
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 48 * 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export function orchestratorHealth(
  heartbeat: OrchestratorHeartbeat | null,
  sources: DashboardSources,
  runningAgents: number,
  now: Date,
): OrchestratorHealth {
  const pollingInterval = heartbeat?.polling_interval_ms ?? sources.polling_interval_ms ?? null;
  const maxConcurrent = heartbeat?.max_concurrent_agents ?? sources.max_concurrent_agents ?? null;
  if (!heartbeat) {
    return {
      alive: false,
      level: 'bad',
      pid: null,
      started_at: null,
      last_heartbeat_at: null,
      heartbeat_age_ms: null,
      polling_interval_ms: pollingInterval,
      max_concurrent_agents: maxConcurrent,
      running_agents: runningAgents,
      shutting_down: false,
      message: 'No orchestrator heartbeat found; is `symphony run` running?',
    };
  }
  const updatedMs = Date.parse(heartbeat.updated_at);
  const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now.getTime() - updatedMs) : null;
  const aliveWindow = heartbeat.polling_interval_ms > 0 ? 2 * heartbeat.polling_interval_ms : ORCHESTRATOR_FALLBACK_ALIVE_MS;
  const pidAlive = processAlive(heartbeat.pid);
  const fresh = ageMs !== null && ageMs <= aliveWindow;
  const alive = fresh && pidAlive !== false;
  let message: string | null = null;
  let level: HealthLevel = 'ok';
  if (!fresh) {
    level = 'bad';
    message = ageMs === null ? 'Heartbeat timestamp is invalid' : `Heartbeat is ${formatAge(ageMs)} old`;
  } else if (pidAlive === false) {
    level = 'bad';
    message = `Orchestrator process ${heartbeat.pid} is not running`;
  } else if (heartbeat.shutting_down) {
    level = 'warn';
    message = 'Orchestrator is shutting down';
  }
  return {
    alive,
    level,
    pid: heartbeat.pid,
    started_at: heartbeat.started_at,
    last_heartbeat_at: heartbeat.updated_at,
    heartbeat_age_ms: ageMs,
    polling_interval_ms: heartbeat.polling_interval_ms,
    max_concurrent_agents: maxConcurrent,
    running_agents: runningAgents,
    shutting_down: alive && heartbeat.shutting_down,
    message,
  };
}

function attentionItem(partial: Partial<AttentionItem> & Pick<AttentionItem, 'id' | 'reason' | 'level' | 'title'>): AttentionItem {
  return {
    repo_id: null,
    task_key: null,
    detail: null,
    issue_number: null,
    issue_url: null,
    pr_number: null,
    pr_url: null,
    workspace_path: null,
    since: null,
    ...partial,
  };
}

const TASK_ATTENTION: Partial<Record<TaskSummary['lifecycle'], { reason: AttentionReason; level: HealthLevel; verb: string }>> = {
  'needs-info': { reason: 'needs_info', level: 'warn', verb: 'Needs info' },
  'waiting-human': { reason: 'waiting_human', level: 'ok', verb: 'Waiting for human' },
  'ready-for-review': { reason: 'ready_for_review', level: 'ok', verb: 'Ready for review' },
  'review-blocked': { reason: 'review_blocked', level: 'warn', verb: 'Review blocked' },
  'review-error': { reason: 'review_error', level: 'bad', verb: 'Review infrastructure error' },
};

function taskLabel(task: TaskSummary): string {
  const ref = task.issue_number !== null ? `#${task.issue_number}` : task.issue_identifier;
  return task.title ? `${ref} ${task.title}` : ref;
}

function taskAttention(local: RepoLocalState): AttentionItem[] {
  const repoId = local.source.repo_id;
  const maxAttempts = local.source.config?.agent.max_attempts ?? null;
  const items: AttentionItem[] = [];
  for (const task of local.tasks) {
    if (task.kind === 'epic' || task.kind === 'loop') continue;
    const base = {
      repo_id: repoId,
      task_key: task.task_key,
      issue_number: task.issue_number,
      issue_url: task.issue_url,
      pr_number: task.pr_number,
      pr_url: task.pr_url,
      workspace_path: task.workspace_path,
      since: task.updated_at,
    };
    if (task.stale) {
      items.push(
        attentionItem({
          ...base,
          id: `stale_run:${task.task_key}`,
          reason: 'stale_run',
          level: 'warn',
          title: `${taskLabel(task)}: no run-state update for a while`,
          detail: `Status ${task.status}; last updated ${task.updated_at}`,
        }),
      );
    }
    if (task.lifecycle === 'failed') {
      const exhausted = isRetryExhausted(task, maxAttempts);
      items.push(
        attentionItem({
          ...base,
          id: `${exhausted ? 'retry_exhausted' : 'failed'}:${task.task_key}`,
          reason: exhausted ? 'retry_exhausted' : 'failed',
          level: 'bad',
          title: `${taskLabel(task)}: ${exhausted ? 'retries exhausted' : 'failed'}`,
          detail: task.last_error ?? (task.attempt !== null ? `Attempt ${task.attempt}${maxAttempts ? ` of ${maxAttempts}` : ''}` : null),
        }),
      );
      continue;
    }
    const rule = TASK_ATTENTION[task.lifecycle];
    if (!rule) continue;
    items.push(
      attentionItem({
        ...base,
        id: `${rule.reason}:${task.task_key}`,
        reason: rule.reason,
        level: rule.level,
        title: `${taskLabel(task)}: ${rule.verb.toLowerCase()}`,
        detail: task.lifecycle === 'needs-info' ? (task.last_error ?? task.pause_reason) : task.pr_number !== null ? `PR #${task.pr_number}` : null,
      }),
    );
  }
  return items;
}

function repoAttention(local: RepoLocalState, now: Date): AttentionItem[] {
  const repoId = local.source.repo_id;
  const items: AttentionItem[] = [];
  const heartbeat = local.heartbeat;
  const nowMs = now.getTime();

  for (const loop of local.loops) {
    if (loop.status === 'failed') {
      items.push(
        attentionItem({
          id: `loop_failed:${loop.task_key}`,
          reason: 'loop_failed',
          level: 'warn',
          repo_id: repoId,
          task_key: loop.task_key,
          title: `Loop ${loop.loop_id} failed`,
          detail: loop.last_error,
          workspace_path: loop.workspace_path,
          since: loop.last_finished_at ?? loop.last_started_at,
        }),
      );
    } else if (loop.status === 'paused' && loop.pause_reason) {
      items.push(
        attentionItem({
          id: `loop_question:${loop.task_key}`,
          reason: 'loop_question',
          level: 'warn',
          repo_id: repoId,
          task_key: loop.task_key,
          title: `Loop ${loop.loop_id} is waiting for an answer`,
          detail: loop.last_error ?? `Paused: ${loop.pause_reason}`,
          workspace_path: loop.workspace_path,
          since: loop.last_finished_at ?? loop.last_started_at,
        }),
      );
    }
  }

  for (const slot of local.slots) {
    if (slot.state !== 'protected') continue;
    items.push(
      attentionItem({
        id: `protected_workspace:${slot.path}`,
        reason: 'protected_workspace',
        level: 'warn',
        repo_id: repoId,
        task_key: slot.task_key,
        title: `${slot.name} kept: protected work${slot.issue_number !== null ? ` from #${slot.issue_number}` : ''}`,
        detail: slot.protected_reason,
        issue_number: slot.issue_number,
        issue_url: slot.issue_url,
        workspace_path: slot.path,
        since: slot.updated_at,
      }),
    );
  }
  // Protected workspaces that are not a recognised slot (e.g. linked worktrees elsewhere).
  const slotPaths = new Set(local.slots.map((slot) => slot.path));
  for (const entry of heartbeat?.protected_workspaces ?? []) {
    if (slotPaths.has(entry.path)) continue;
    items.push(
      attentionItem({
        id: `protected_workspace:${entry.path}`,
        reason: 'protected_workspace',
        level: 'warn',
        repo_id: repoId,
        task_key: entry.issue_number !== null ? `${repoId}/${entry.issue_number}` : null,
        title: `Workspace kept: protected work${entry.issue_number !== null ? ` from #${entry.issue_number}` : ''}`,
        detail: entry.reason,
        issue_number: entry.issue_number,
        workspace_path: entry.path,
        since: heartbeat?.tick_started_at ?? null,
      }),
    );
  }

  const deferrals = heartbeat?.dispatch_deferrals ?? [];
  if (deferrals.length > 0) {
    const reasons = [...new Set(deferrals.map((entry) => entry.reason))];
    items.push(
      attentionItem({
        id: `dispatch_deferred:${repoId}`,
        reason: 'dispatch_deferred',
        level: 'warn',
        repo_id: repoId,
        title: `${repoId}: dispatch deferred`,
        detail: `${deferrals.length} deferral${deferrals.length === 1 ? '' : 's'} last tick: ${reasons.join('; ')}`,
        since: deferrals.map((entry) => entry.at).sort().pop() ?? null,
      }),
    );
  }

  const pool = local.summary.pool;
  if (pool.slots_max !== null && pool.slots_total > 0 && pool.slots_in_use >= pool.slots_max) {
    items.push(
      attentionItem({
        id: `pool_exhausted:${repoId}`,
        reason: 'pool_exhausted',
        level: 'warn',
        repo_id: repoId,
        title: `${repoId}: workspace pool exhausted`,
        detail: `${pool.slots_in_use} of ${pool.slots_max} pool slots in use${pool.slots_protected ? `, ${pool.slots_protected} protected` : ''}`,
      }),
    );
  }

  for (const flag of local.summary.flags) {
    const reason: AttentionReason | null =
      flag.kind === 'provider_backoff' ? 'provider_backoff' : flag.kind === 'github_backoff' ? 'github_backoff' : flag.kind === 'storage_blocked' ? 'storage_blocked' : null;
    if (!reason) continue;
    items.push(
      attentionItem({
        id: `${reason}:${repoId}`,
        reason,
        level: flag.level,
        repo_id: repoId,
        title: `${repoId}: ${flag.message}`,
        since: flag.since,
      }),
    );
  }

  items.push(...mergeBlockedAttention(local, nowMs));
  return items;
}

function mergeBlockedAttention(local: RepoLocalState, nowMs: number): AttentionItem[] {
  const repoId = local.source.repo_id;
  const items: AttentionItem[] = [];
  const githubPrs = local.github?.last_refreshed_at ? local.github.pull_requests : null;
  const open = githubPrs ? new Map(githubPrs.map((pr) => [pr.number, pr])) : null;
  for (const [prNumber, event] of local.merge_events) {
    if (event.event !== 'merge.blocked') continue;
    if (open ? !open.has(prNumber) : nowMs - Date.parse(event.created_at) > MERGE_BLOCK_LOCAL_WINDOW_MS) continue;
    const reasons = Array.isArray(event.payload.reasons) ? event.payload.reasons.filter((value): value is string => typeof value === 'string') : [];
    const issueNumber = local.pr_to_issue.get(prNumber) ?? numberField(event.payload.issue_number);
    const pr = open?.get(prNumber);
    items.push(
      attentionItem({
        id: `merge_blocked:${repoId}:${prNumber}`,
        reason: 'merge_blocked',
        level: 'warn',
        repo_id: repoId,
        task_key: `${repoId}/${issueNumber ?? prNumber}`,
        title: `PR #${prNumber}${pr?.title ? ` ${pr.title}` : ''}: merge blocked`,
        detail: reasons.length > 0 ? reasons.join('; ') : null,
        issue_number: issueNumber,
        pr_number: prNumber,
        pr_url: pr?.url ?? null,
        since: event.created_at,
      }),
    );
  }
  return items;
}

/** bad → warn → unknown → ok, newest first within a level; `orchestrator_down` always leads. */
export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  const unique = new Map<string, AttentionItem>();
  for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item);
  const pinned = (item: AttentionItem) => (item.reason === 'orchestrator_down' ? 1 : 0);
  return [...unique.values()].sort(
    (a, b) => pinned(b) - pinned(a) || levelRank(b.level) - levelRank(a.level) || (b.since ?? '').localeCompare(a.since ?? ''),
  );
}

async function runningTasks(locals: RepoLocalState[], access: ArtifactAccess, now: Date): Promise<RunningTask[]> {
  const running: RunningTask[] = [];
  for (const local of locals) {
    for (const task of local.tasks) {
      if (task.kind === 'epic' || !isRunningStatus(task.status)) continue;
      const state = local.task_runs.get(task.task_key)?.[0] ?? null;
      const startedAt = state?.started_at ?? null;
      const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
      running.push({
        task_key: task.task_key,
        kind: task.kind,
        repo_id: task.repo_id,
        issue_number: task.issue_number,
        issue_identifier: task.issue_identifier,
        issue_url: task.issue_url,
        loop_id: task.loop_id,
        title: task.title,
        status: state?.status ?? 'agent-running',
        agent_provider: task.agent_provider,
        agent_mode: task.agent_mode,
        attempt: task.attempt ?? 0,
        session_id: state?.session_id ?? null,
        started_at: startedAt,
        elapsed_ms: Number.isFinite(startedMs) ? Math.max(0, now.getTime() - startedMs) : null,
        last_activity: null,
        last_activity_at: null,
        usage: null,
        pr_number: task.pr_number,
        pr_url: task.pr_url,
        workspace_path: task.workspace_path ?? state?.workspace_path ?? '',
        artifacts: artifactPathsFor(state),
      });
    }
  }
  running.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
  await Promise.all(
    running.slice(0, MAX_ENRICHED_RUNNING_TASKS).map(async (task) => {
      const log = task.artifacts.agent_log;
      if (!log) return;
      const [activity, usage] = await Promise.all([
        lastAgentActivity(access, log).catch(() => null),
        overviewAgentUsage(access, log),
      ]);
      task.last_activity = activity?.text ?? null;
      task.last_activity_at = activity?.at ?? null;
      task.usage = usage;
    }),
  );
  return running;
}

export async function loadOverviewState(sources: DashboardSources, options: ReadModelOptions = {}): Promise<OverviewState> {
  const now = options.now ?? new Date();
  const [locals, heartbeat] = await Promise.all([
    loadAllLocal(sources, { ...options, now }),
    readOrchestratorHeartbeat(sources.control_dir).catch(() => null),
  ]);
  const running = await runningTasks(locals, { allowedRoots: sources.allowed_roots, symphonyArtifactsOnly: true }, now);
  const orchestrator = orchestratorHealth(heartbeat, sources, running.length, now);

  const items: AttentionItem[] = [];
  if (orchestrator.level === 'bad') {
    items.push(
      attentionItem({
        id: 'orchestrator_down',
        reason: 'orchestrator_down',
        level: 'bad',
        title: 'Orchestrator is not running',
        detail: orchestrator.message,
        since: orchestrator.last_heartbeat_at,
      }),
    );
  }
  for (const local of locals) items.push(...taskAttention(local), ...repoAttention(local, now));
  const attention = sortAttention(items);

  const repos = locals
    .map((local) => local.summary)
    .sort((a, b) => levelRank(b.level) - levelRank(a.level) || a.repo_id.localeCompare(b.repo_id));
  const epics = locals
    .flatMap((local) => local.epics)
    .filter((epic) => epic.status === 'coordinating')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return {
    generated_at: now.toISOString(),
    source: sources.source,
    orchestrator,
    totals: {
      repos: repos.length,
      running: running.length,
      queued: repos.reduce((sum, repo) => sum + repo.counts.queued, 0),
      retrying: repos.reduce((sum, repo) => sum + repo.counts.retrying, 0),
      attention: attention.length,
      attention_bad: attention.filter((item) => item.level === 'bad').length,
    },
    attention,
    running,
    repos,
    epics,
  };
}
