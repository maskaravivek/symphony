import type { Issue } from '../domain/issue.js';
import { leafEpicNodes, type EpicTreeNode } from '../domain/epic.js';
import { GithubIssueTrackerClient, isGithubRateLimitError, type IssueComment, type PullRequestRef } from '../github/githubClient.js';
import { runAgent, assertAgentEligibleCommand } from '../runner/agentRunner.js';
import { extractCodexThreadId } from '../runner/codexEvents.js';
import { renderPrompt, renderTemplate } from '../templating/renderPrompt.js';
import { SymphonyConfigError } from '../utils/errors.js';
import { log, type LogFields } from '../utils/log.js';
import { sleep } from '../utils/sleep.js';
import { recoverFreshRunGitState } from '../workspace/gitRecovery.js';
import { runHookScript } from '../workspace/hooks.js';
import { WorkspaceManager, workspacePathForIssue } from '../workspace/workspaceManager.js';
import { loadWorkflowFromFile } from '../workflow/loadWorkflow.js';
import type { AgentProviderConfig, LoadedWorkflow, WorkflowConfig, WorkspaceStrategy } from '../workflow/types.js';
import { readRunState, updateRunState, writeRunState, type AgentMode, type PauseReason, type RunState } from '../status/runState.js';
import { scanRunStates } from '../status/scanRunStates.js';
import { readEpicStates, upsertEpicState, type EpicChildState, type EpicState } from '../status/epicState.js';
import { buildRunContext } from './runContext.js';
import { formatPauseComment, parsePauseRequest } from './pauseProtocol.js';
import { formatStatusComment, statusMarker } from './statusComment.js';
import { epicStatusMarker, formatEpicStatusComment } from './epicStatusComment.js';
import { acquireWorkflowLock, type WorkflowLock } from './workflowLock.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';

interface DispatchCapacity {
  remaining: number | null;
}

type DispatchBlockReason = 'global_capacity' | 'state_capacity' | 'provider_capacity' | 'usage_limit';
type UsageLimitCheckResult = 'allowed' | 'blocked' | 'unknown';

export interface OrchestratorOptions {
  workflowPath: string;
  repoId?: string | null;
  maxConcurrentAgents?: number | null;
}

interface RetryEntry {
  attempt: number;
  next_run_at_ms: number;
  issue_number: number;
  issue_id: string;
}

interface ConflictEntry {
  pr_number: number;
  issue_number: number;
  head_ref: string;
  base_ref: string;
  url: string | null;
  next_run_at_ms: number;
}

interface ConflictDispatchOptions {
  pr_number: number;
  pr_url: string | null;
  head_ref: string;
  base_ref: string;
}

interface PullRequestReviewDispatchOptions {
  pr_number: number;
  pr_url: string | null;
  head_ref: string;
  base_ref: string;
}

interface RunningSession {
  issue_id: string;
  issue_number: number;
  issue_identifier: string;
  issue_url: string | null;
  issue_state: string;
  workspace_path: string;
  session_id: string;
  agent_provider: string;
  agent_provider_group: string;
  started_at_ms: number;
  cancelled_reason: string | null;
  cancel: (reason: string) => Promise<void>;
  done: Promise<void> | null;
}

interface LiveOrphanClaim {
  issue_state: string;
  agent_provider_group: string;
}

interface StackContext {
  root_issue_identifier: string;
  root_issue_number: number | null;
  predecessor_issue_identifier: string | null;
  predecessor_issue_number: number | null;
  base_branch: string | null;
  reusable_thread_id: string | null;
  predecessor_last_message: string | null;
  position: number;
  total: number;
}

interface EpicStackPlanEntry {
  can_queue: boolean;
  skipped_reason: string | null;
}

type EpicExecutionMode = WorkflowConfig['tracker']['epics']['execution_mode'];

const LABEL_READY = 'ready-for-agent';
const LABEL_RUNNING = 'agent-running';
const LABEL_INTERACTIVE = 'interactive';
const LABEL_NEEDS_INFO = 'needs-info';
const LABEL_READY_FOR_HUMAN = 'ready-for-human';
const LABEL_PLANNING = 'planning';
const LABEL_TASK_SPEC = 'task:spec';
const LABEL_EPIC_STACKED = 'epic:stacked';
const LABEL_EPIC_INDEPENDENT = 'epic:independent';

function nowMs(): number {
  return Date.now();
}

function hasAllLabels(labels: string[], required: string[]): boolean {
  const set = new Set(labels);
  return required.every((l) => set.has(l));
}

function hasAnyLabel(labels: string[], ignored: string[]): boolean {
  const set = new Set(labels);
  return ignored.some((l) => set.has(l));
}

function hasAnyOf(labels: string[], requiredAny: string[] | null): boolean {
  if (!requiredAny || requiredAny.length === 0) return true;
  const set = new Set(labels);
  return requiredAny.some((l) => set.has(l));
}

function isPlanningIssue(labels: string[]): boolean {
  const set = new Set(labels.map((label) => label.trim().toLowerCase()));
  return set.has(LABEL_PLANNING) || set.has(LABEL_TASK_SPEC);
}

function computeBackoffMs(attempt: number, maxBackoffMs: number): number {
  const delay = 10_000 * Math.pow(2, attempt - 1);
  return Math.min(delay, maxBackoffMs);
}

function shouldRetryCancelledRun(reason: string): boolean {
  return reason === 'shutdown' || reason.startsWith('signal:');
}

function normalizeBranchPrefix(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function issueNumberFromPullRequestBody(body: string | null): number | null {
  if (!body) return null;
  const match = /(?:^|[^A-Za-z])Fixes\s+#(\d+)(?:[^0-9]|$)/i.exec(body);
  return match ? Number(match[1]) : null;
}

function isDirtyMergeState(value: string | null): boolean {
  return value?.toLowerCase() === 'dirty';
}

function shouldWaitForMergeState(value: string | null): boolean {
  const normalized = value?.toLowerCase();
  return !normalized || normalized === 'unknown' || normalized === 'unstable' || normalized === 'blocked';
}

function runGit(workspacePath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: workspacePath }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function getIssueLogFields(config: WorkflowConfig, issue: Issue, repoId: string | null = null): LogFields {
  return {
    repo_id: repoId ?? undefined,
    tracker_kind: config.tracker.kind,
    owner: config.tracker.owner,
    repo: config.tracker.repo,
    issue_id: issue.id,
    issue_number: issue.number,
    issue_identifier: issue.identifier,
    issue_url: issue.url,
  };
}

function issueRepoParts(issue: Issue): { owner: string; repo: string; number: number } | null {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(issue.identifier);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function isSameTrackerRepo(config: WorkflowConfig, issue: Issue): boolean {
  const parts = issueRepoParts(issue);
  return Boolean(parts && parts.owner === config.tracker.owner && parts.repo === config.tracker.repo);
}

function isTerminalIssue(config: WorkflowConfig, issue: Issue): boolean {
  return config.tracker.terminal_states.includes(issue.state);
}

function labelsMatchRoute(labels: string[], route: WorkflowConfig['agents']['routes'][number]): boolean {
  const set = new Set(labels.map((label) => label.trim().toLowerCase()));
  if (route.none_labels.some((label) => set.has(label))) return false;
  if (route.all_labels.some((label) => !set.has(label))) return false;
  if (route.any_labels.length > 0 && !route.any_labels.some((label) => set.has(label))) return false;
  return route.default || route.any_labels.length > 0 || route.all_labels.length > 0 || route.none_labels.length > 0;
}

function selectAgentProvider(config: WorkflowConfig, issue: Issue): AgentProviderConfig {
  const labels = issue.labels.map((label) => label.trim().toLowerCase());
  const route = config.agents.routes.find((candidate) => labelsMatchRoute(labels, candidate));
  const providerId = route?.provider ?? config.agents.default;
  const provider = config.agents.providers[providerId];
  if (!provider) throw new SymphonyConfigError(`agent provider not found: ${providerId}`);
  return provider;
}

function resolveAgentLogPath(workspacePath: string, provider: AgentProviderConfig): string {
  return path.isAbsolute(provider.output_log) ? provider.output_log : path.join(workspacePath, provider.output_log);
}

function isCodexProvider(provider: AgentProviderConfig): boolean {
  return provider.provider_kind === 'codex' || provider.extract_codex_thread_id;
}

function providerLimitKey(provider: AgentProviderConfig): string {
  return provider.provider_group || provider.id;
}

function collectEpicChildren(root: EpicTreeNode): Array<{ node: EpicTreeNode; depth: number }> {
  const out: Array<{ node: EpicTreeNode; depth: number }> = [];
  const visit = (node: EpicTreeNode, depth: number) => {
    if (depth > 0) out.push({ node, depth });
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return out;
}

function resolveEpicExecutionMode(config: WorkflowConfig, epicIssue: Issue): EpicExecutionMode {
  const labels = new Set(epicIssue.labels.map((label) => label.trim().toLowerCase()));
  const wantsStacked = labels.has(LABEL_EPIC_STACKED);
  const wantsIndependent = labels.has(LABEL_EPIC_INDEPENDENT);

  if (wantsStacked && !wantsIndependent) return 'stacked';
  if (wantsIndependent && !wantsStacked) return 'independent';
  return config.tracker.epics.execution_mode;
}

export class Orchestrator {
  private workflowPath: string;
  private repoId: string | null;
  private maxConcurrentAgentsOverride: number | null;
  private lastGoodWorkflow: LoadedWorkflow | null = null;

  private running = new Map<string, RunningSession>();
  private retries = new Map<string, RetryEntry>();
  private conflictQueue = new Map<number, ConflictEntry>();
  private lastConflictScanAtMs = 0;
  private providerUsageLimitBackoffUntil = new Map<string, number>();
  private providerUsageLimitCheckBlocked = new Set<string>();
  private githubRateLimitBackoffUntilMs = 0;
  private workflowLock: WorkflowLock | null = null;
  private liveOrphanClaims = new Map<string, LiveOrphanClaim>();
  private liveOrphanLogLastAtMs = new Map<string, number>();

  private stopped = false;

  constructor(options: OrchestratorOptions) {
    this.workflowPath = options.workflowPath;
    this.repoId = options.repoId ?? null;
    this.maxConcurrentAgentsOverride = options.maxConcurrentAgents ?? null;
  }

  getRunningCount(): number {
    return this.running.size + this.liveOrphanClaims.size;
  }

  getRepoId(): string | null {
    return this.repoId;
  }

  setMaxConcurrentAgentsOverride(value: number | null): void {
    this.maxConcurrentAgentsOverride = value;
  }

  stop(): void {
    this.stopped = true;
  }

  async shutdown(reason = 'shutdown'): Promise<void> {
    this.stopped = true;
    const sessions = [...this.running.values()];
    await Promise.allSettled(
      sessions.map(async (s) => {
        s.cancelled_reason = reason;
        await s.cancel(reason);
        await s.done;
      }),
    );
    await this.releaseWorkflowLock();
  }

  async runForever(): Promise<void> {
    while (!this.stopped) {
      await this.tickOnce().catch((err) => {
        log('error', 'tick_failed', { event: 'tick_failed', error: err instanceof Error ? err.message : String(err) });
      });
      const interval = this.lastGoodWorkflow?.config.polling.interval_ms ?? 30_000;
      await sleep(interval);
    }
  }

  async tickOnce(options: { maxNewDispatches?: number | null } = {}): Promise<void> {
    const loaded = await this.loadWorkflowSafe();
    if (!loaded) return;
    const { config } = loaded;

    if (!(await this.ensureWorkflowLock(config))) return;

    if (this.isGithubRateLimitBackoffActive(config)) return;

    const trackerClient = new GithubIssueTrackerClient(config.tracker);
    const workspaceManager = new WorkspaceManager(config.workspace, this.maxConcurrentAgentsOverride ?? config.agent.max_concurrent_agents);

    try {
      await this.reconcileRunning(config, trackerClient, workspaceManager);
      await this.reconcileOrphanedClaims(config, trackerClient, workspaceManager);
      await this.sweepTerminalWorkspaces(config, trackerClient, workspaceManager);
      await this.refreshProviderUsageLimitChecks(config);
      const capacity: DispatchCapacity = { remaining: options.maxNewDispatches ?? null };
      await this.scanOpenPullRequestsForConflicts(config, trackerClient);
      await this.dispatchConflictResolutions(config, trackerClient, workspaceManager, capacity);
      await this.dispatchPullRequestReviews(config, trackerClient, workspaceManager, capacity);

      let candidates: Issue[];
      try {
        candidates = await trackerClient.fetchCandidateIssues();
      } catch (err) {
        if (this.handleGithubRateLimit(config, err, 'github_candidate_fetch_rate_limited')) return;
        log('error', 'github_candidate_fetch_failed', {
          repo_id: this.repoId ?? undefined,
          tracker_kind: config.tracker.kind,
          owner: config.tracker.owner,
          repo: config.tracker.repo,
          event: 'github_candidate_fetch_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      const epicParentIds = config.tracker.epics.enabled ? await this.processEpicCandidates(config, trackerClient, candidates) : new Set<string>();
      const eligibleCandidates = candidates.filter((issue) => !this.running.has(issue.id) && !epicParentIds.has(issue.id));

      await this.dispatchReadyRetries(config, trackerClient, eligibleCandidates, workspaceManager, capacity);
      await this.dispatchNewIssues(config, trackerClient, eligibleCandidates, workspaceManager, capacity);
    } catch (err) {
      if (this.handleGithubRateLimit(config, err, 'github_rate_limited')) return;
      throw err;
    }
  }

  private async ensureWorkflowLock(config: WorkflowConfig): Promise<boolean> {
    if (this.workflowLock?.workspace_root === config.workspace.root) return true;
    if (this.workflowLock) await this.releaseWorkflowLock();

    const result = await acquireWorkflowLock({
      workspaceRoot: config.workspace.root,
      repoId: this.repoId,
      owner: config.tracker.owner,
      repo: config.tracker.repo,
      workflowPath: this.workflowPath,
    });

    if (result.acquired) {
      this.workflowLock = result.lock;
      log('info', 'workflow_lock_acquired', {
        repo_id: this.repoId ?? undefined,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'workflow_lock_acquired',
        workspace_root: config.workspace.root,
        lock_path: result.lock.lock_path,
        worker_pid: process.pid,
      });
      return true;
    }

    log('warn', 'workflow_lock_unavailable', {
      repo_id: this.repoId ?? undefined,
      owner: config.tracker.owner,
      repo: config.tracker.repo,
      event: 'workflow_lock_unavailable',
      workspace_root: config.workspace.root,
      lock_path: result.lock_path,
      owner_pid: result.owner?.pid,
      owner_hostname: result.owner?.hostname,
      owner_repo_id: result.owner?.repo_id ?? undefined,
      owner_workflow_path: result.owner?.workflow_path,
      owner_acquired_at: result.owner?.acquired_at,
    });
    return false;
  }

  private async releaseWorkflowLock(): Promise<void> {
    const lock = this.workflowLock;
    this.workflowLock = null;
    await lock?.release();
  }

  private isGithubRateLimitBackoffActive(config: WorkflowConfig): boolean {
    const now = nowMs();
    if (now >= this.githubRateLimitBackoffUntilMs) return false;
    log('warn', 'github_rate_limit_backoff_active', {
      repo_id: this.repoId ?? undefined,
      tracker_kind: config.tracker.kind,
      owner: config.tracker.owner,
      repo: config.tracker.repo,
      event: 'github_rate_limit_backoff_active',
      retry_in_ms: this.githubRateLimitBackoffUntilMs - now,
    });
    return true;
  }

  private handleGithubRateLimit(config: WorkflowConfig, err: unknown, event: string): boolean {
    if (!isGithubRateLimitError(err)) return false;
    const now = nowMs();
    const fallbackMs = Math.max(config.polling.interval_ms, 60_000);
    const until = err.resetAtMs ?? (err.retryAfterMs !== null ? now + err.retryAfterMs : now + fallbackMs);
    this.githubRateLimitBackoffUntilMs = Math.max(this.githubRateLimitBackoffUntilMs, until);
    log('warn', event, {
      repo_id: this.repoId ?? undefined,
      tracker_kind: config.tracker.kind,
      owner: config.tracker.owner,
      repo: config.tracker.repo,
      event,
      retry_in_ms: Math.max(0, this.githubRateLimitBackoffUntilMs - now),
      error: err.message,
    });
    return true;
  }

  private async loadWorkflowSafe(): Promise<LoadedWorkflow | null> {
    try {
      const loaded = await loadWorkflowFromFile(this.workflowPath);
      this.validateWorkflow(loaded.config);
      this.lastGoodWorkflow = loaded;
      return loaded;
    } catch (err) {
      log('error', 'workflow_load_failed', {
        event: 'workflow_load_failed',
        repo_id: this.repoId ?? undefined,
        workflow_path: this.workflowPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.lastGoodWorkflow;
    }
  }

  private validateWorkflow(config: WorkflowConfig): void {
    if (config.tracker.kind !== 'github') throw new SymphonyConfigError('tracker.kind must be github');
    if (!config.tracker.owner) throw new SymphonyConfigError('tracker.owner is required');
    if (!config.tracker.repo) throw new SymphonyConfigError('tracker.repo is required');
    if (!config.tracker.token) {
      throw new SymphonyConfigError(
        'tracker.token is required (set tracker.token: $GITHUB_TOKEN and export GITHUB_TOKEN, or provide a literal token)',
      );
    }
    if (!config.agents.default) throw new SymphonyConfigError('agents.default is required');
    if (!config.agents.providers[config.agents.default]) throw new SymphonyConfigError(`agents.default references unknown provider: ${config.agents.default}`);
    if (!config.workspace.root) throw new SymphonyConfigError('workspace.root is required');
    for (const provider of Object.values(config.agents.providers)) {
      assertAgentEligibleCommand(provider.command, `agents.providers.${provider.id}.command`);
      if (provider.resume_command) assertAgentEligibleCommand(provider.resume_command, `agents.providers.${provider.id}.resume_command`);
      if (provider.handoff_command) assertAgentEligibleCommand(provider.handoff_command, `agents.providers.${provider.id}.handoff_command`);
      if (provider.usage_limit_check_command) {
        assertAgentEligibleCommand(provider.usage_limit_check_command, `agents.providers.${provider.id}.usage_limit_check_command`);
      }
    }
  }

  private async reconcileRunning(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    workspaceManager: WorkspaceManager,
  ): Promise<void> {
    for (const session of this.running.values()) {
      const issue = await tracker.fetchIssueByNumber(session.issue_number);
      if (!issue) continue;

      const fields = { ...getIssueLogFields(config, issue, this.repoId), session_id: session.session_id, workspace_path: session.workspace_path };

      if (config.tracker.terminal_states.includes(issue.state)) {
        log('info', 'worker_cancelled_by_reconciliation', { ...fields, event: 'worker_cancelled_by_reconciliation', reason: 'terminal_state' });
        session.cancelled_reason = 'terminal_state';
        await session.cancel('issue reached terminal state');
        this.running.delete(issue.id);
        if (issue.number) await this.applyLabels(config, issue.number, { remove: [LABEL_READY, LABEL_RUNNING] }).catch(() => {});
        await updateRunState(session.workspace_path, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: 'cancelled',
            labels: (cur.labels ?? issue.labels).filter((label) => label !== LABEL_READY && label !== LABEL_RUNNING),
            workflow_state: null,
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        });
        await workspaceManager.cleanWorkspace(session.workspace_path);
        continue;
      }

      if (hasAnyLabel(issue.labels, config.tracker.ignored_labels)) {
        log('info', 'worker_cancelled_by_reconciliation', { ...fields, event: 'worker_cancelled_by_reconciliation', reason: 'ignored_label' });
        session.cancelled_reason = 'ignored_label';
        await session.cancel('issue gained ignored label');
        this.running.delete(issue.id);
        await updateRunState(session.workspace_path, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: 'cancelled',
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        });
        continue;
      }

      const isClaimedByAgent = issue.labels.includes(LABEL_RUNNING);
      if (!isClaimedByAgent && !hasAllLabels(issue.labels, config.tracker.required_labels)) {
        log('info', 'worker_cancelled_by_reconciliation', {
          ...fields,
          event: 'worker_cancelled_by_reconciliation',
          reason: 'missing_required_label',
        });
        session.cancelled_reason = 'missing_required_label';
        await session.cancel('issue missing required labels');
        this.running.delete(issue.id);
        await updateRunState(session.workspace_path, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: 'cancelled',
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        });
        continue;
      }

      if (!hasAnyOf(issue.labels, config.tracker.any_required_labels)) {
        log('info', 'worker_cancelled_by_reconciliation', {
          ...fields,
          event: 'worker_cancelled_by_reconciliation',
          reason: 'missing_any_required_labels',
        });
        session.cancelled_reason = 'missing_any_required_labels';
        await session.cancel('issue missing any-required labels');
        this.running.delete(issue.id);
        await updateRunState(session.workspace_path, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: 'cancelled',
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        });
        continue;
      }
    }
  }

  private async reconcileOrphanedClaims(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    workspaceManager: WorkspaceManager,
  ): Promise<void> {
    let issues: Issue[];
    try {
      issues = await tracker.fetchIssuesByStates(config.tracker.active_states);
    } catch (err) {
      if (isGithubRateLimitError(err)) throw err;
      log('error', 'orphaned_claim_reconcile_failed', {
        repo_id: this.repoId ?? undefined,
        tracker_kind: config.tracker.kind,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'orphaned_claim_reconcile_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.liveOrphanClaims.clear();

    for (const issue of issues) {
      if (!issue.labels.includes(LABEL_RUNNING)) continue;
      if (this.running.has(issue.id)) continue;

      const existingState = await this.readRunStateForIssue(config, issue);
      const { workspace_path: fallbackWorkspacePath } = existingState
        ? { workspace_path: existingState.workspace_path }
        : await workspaceManager.ensureWorkspace(issue, { strategy: 'durable_issue_workspace' });
      const workspacePath = fallbackWorkspacePath;
      const state = existingState ?? (await readRunState(workspacePath));
      if (state?.status === 'running' && isProcessAlive(state.worker_pid)) {
        const provider = selectAgentProvider(config, issue);
        this.liveOrphanClaims.set(issue.id, {
          issue_state: issue.state,
          agent_provider_group: state.agent_provider_group ?? providerLimitKey(provider),
        });
        if (this.shouldLogLiveOrphanClaim(issue.id)) {
          log('info', 'orphaned_claim_still_running', {
            ...getIssueLogFields(config, issue, this.repoId),
            workspace_path: workspacePath,
            event: 'orphaned_claim_still_running',
            worker_pid: state.worker_pid ?? undefined,
          });
        }
        continue;
      }

      const ignored = hasAnyLabel(issue.labels, config.tracker.ignored_labels);
      const nextLabels = ignored ? { remove: [LABEL_RUNNING] } : { add: [LABEL_READY], remove: [LABEL_RUNNING] };
      const nextWorkflowState = ignored ? null : LABEL_READY;
      const reason = state?.status === 'running' ? 'worker_pid_not_alive' : 'agent_running_without_running_state';

      log('warn', 'orphaned_claim_recovered', {
        ...getIssueLogFields(config, issue, this.repoId),
        workspace_path: workspacePath,
        event: 'orphaned_claim_recovered',
        status: 'cancelled',
        reason,
        worker_pid: state?.worker_pid ?? undefined,
      });

      await this.applyLabels(config, issue.number!, nextLabels);
      await updateRunState(workspacePath, (cur) =>
        cur
          ? {
              ...cur,
              status: 'cancelled',
              labels: ignored
                ? (cur.labels ?? issue.labels).filter((label) => label !== LABEL_RUNNING)
                : [...new Set([...(cur.labels ?? issue.labels).filter((label) => label !== LABEL_RUNNING), LABEL_READY])],
              workflow_state: nextWorkflowState,
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
          : null,
      );
    }
  }

  private shouldLogLiveOrphanClaim(issueId: string): boolean {
    const now = nowMs();
    const last = this.liveOrphanLogLastAtMs.get(issueId);
    if (last !== undefined && now - last < 5 * 60_000) return false;
    this.liveOrphanLogLastAtMs.set(issueId, now);
    return true;
  }

  private async sweepTerminalWorkspaces(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    workspaceManager: WorkspaceManager,
  ): Promise<void> {
    if (!config.workspace.clean_on_terminal) return;

    let states: RunState[];
    try {
      states = await scanRunStates(config.workspace.root);
    } catch (err) {
      log('error', 'terminal_workspace_sweep_failed', {
        repo_id: this.repoId ?? undefined,
        tracker_kind: config.tracker.kind,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'terminal_workspace_sweep_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const state of states) {
      if (this.running.has(state.issue_id)) continue;
      if (state.status === 'running' && isProcessAlive(state.worker_pid)) continue;
      if (!state.issue_number) continue;

      let issue: Issue | null;
      try {
        issue = await tracker.fetchIssueByNumber(state.issue_number);
      } catch (err) {
        if (isGithubRateLimitError(err)) throw err;
        log('error', 'terminal_workspace_issue_fetch_failed', {
          repo_id: this.repoId ?? undefined,
          tracker_kind: config.tracker.kind,
          owner: config.tracker.owner,
          repo: config.tracker.repo,
          issue_id: state.issue_id,
          issue_number: state.issue_number,
          issue_identifier: state.issue_identifier,
          issue_url: state.issue_url,
          workspace_path: state.workspace_path,
          event: 'terminal_workspace_issue_fetch_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!issue || !config.tracker.terminal_states.includes(issue.state)) continue;

      log('info', 'terminal_workspace_cleaning', {
        ...getIssueLogFields(config, issue, this.repoId),
        workspace_path: state.workspace_path,
        event: 'terminal_workspace_cleaning',
        run_status: state.status,
      });

      try {
        await workspaceManager.cleanWorkspace(state.workspace_path);
        log('info', 'terminal_workspace_cleaned', {
          ...getIssueLogFields(config, issue, this.repoId),
          workspace_path: state.workspace_path,
          event: 'terminal_workspace_cleaned',
          run_status: state.status,
        });
      } catch (err) {
        log('error', 'terminal_workspace_clean_failed', {
          ...getIssueLogFields(config, issue, this.repoId),
          workspace_path: state.workspace_path,
          event: 'terminal_workspace_clean_failed',
          run_status: state.status,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async scanOpenPullRequestsForConflicts(config: WorkflowConfig, tracker: GithubIssueTrackerClient): Promise<void> {
    const now = nowMs();
    const intervalMs = 30 * 60 * 1000;
    if (this.lastConflictScanAtMs && now - this.lastConflictScanAtMs < intervalMs) return;
    this.lastConflictScanAtMs = now;

    let prs: PullRequestRef[];
    try {
      prs = await tracker.listOpenPullRequests();
    } catch (err) {
      if (isGithubRateLimitError(err)) throw err;
      log('error', 'pr_conflict_scan_failed', {
        repo_id: this.repoId ?? undefined,
        tracker_kind: config.tracker.kind,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'pr_conflict_scan_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const pr of prs) {
      if (!this.isSymphonyPullRequest(config, pr)) continue;
      if (pr.is_draft) continue;
      const detailed = await tracker.fetchPullRequest(pr.number).catch(() => pr);
      if (!detailed || shouldWaitForMergeState(detailed.merge_state_status)) continue;
      if (!isDirtyMergeState(detailed.merge_state_status)) continue;

      const issueNumber = issueNumberFromPullRequestBody(detailed.body);
      if (!issueNumber) continue;
      if (this.conflictQueue.has(detailed.number)) continue;

      this.conflictQueue.set(detailed.number, {
        pr_number: detailed.number,
        issue_number: issueNumber,
        head_ref: detailed.head_ref,
        base_ref: detailed.base_ref || 'main',
        url: detailed.url,
        next_run_at_ms: now,
      });

      log('warn', 'pr_conflict_queued', {
        repo_id: this.repoId ?? undefined,
        tracker_kind: config.tracker.kind,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'pr_conflict_queued',
        pr_number: detailed.number,
        issue_number: issueNumber,
        head_ref: detailed.head_ref,
        merge_state_status: detailed.merge_state_status ?? 'unknown',
      });
    }
  }

  private isSymphonyPullRequest(config: WorkflowConfig, pr: PullRequestRef): boolean {
    const prefix = normalizeBranchPrefix(config.tracker.branch_prefix);
    const hasPrefix = prefix ? pr.head_ref.startsWith(`${prefix}-`) : false;
    return hasPrefix && issueNumberFromPullRequestBody(pr.body) !== null;
  }

  private hasConflictResolverRunning(): boolean {
    return [...this.running.values()].some((session) => session.issue_state === 'conflict-resolution');
  }

  private async dispatchConflictResolutions(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    workspaceManager: WorkspaceManager,
    capacity: DispatchCapacity,
  ): Promise<void> {
    if (this.hasConflictResolverRunning()) return;
    if (capacity.remaining !== null && capacity.remaining <= 0) return;
    const now = nowMs();
    const entry = [...this.conflictQueue.values()]
      .filter((candidate) => candidate.next_run_at_ms <= now)
      .sort((a, b) => a.pr_number - b.pr_number)[0];
    if (!entry) return;

    const latestPr = await tracker.fetchPullRequest(entry.pr_number).catch(() => null);
    if (!latestPr || !isDirtyMergeState(latestPr.merge_state_status)) {
      this.conflictQueue.delete(entry.pr_number);
      return;
    }

    const issue = await tracker.fetchIssueByNumber(entry.issue_number);
    if (!issue || !issue.number) {
      this.conflictQueue.delete(entry.pr_number);
      return;
    }
    if (this.shouldSkipConflictResolution(issue)) {
      this.conflictQueue.delete(entry.pr_number);
      return;
    }
    const provider = selectAgentProvider(config, issue);
    if (this.dispatchBlockReason(config, issue, provider, capacity)) return;

    try {
      await this.dispatchIssue(config, issue, workspaceManager, {
        attempt: 1,
        mode: 'resolve-conflicts',
        provider,
        conflict: {
          pr_number: entry.pr_number,
          pr_url: entry.url,
          head_ref: entry.head_ref,
          base_ref: entry.base_ref,
        },
      });
      this.conflictQueue.delete(entry.pr_number);
      if (capacity.remaining !== null) capacity.remaining -= 1;
    } catch (err) {
      entry.next_run_at_ms = nowMs() + 5 * 60 * 1000;
      log('error', 'conflict_resolution_dispatch_failed', {
        ...getIssueLogFields(config, issue, this.repoId),
        event: 'conflict_resolution_dispatch_failed',
        pr_number: entry.pr_number,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatchPullRequestReviews(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    workspaceManager: WorkspaceManager,
    capacity: DispatchCapacity,
  ): Promise<void> {
    if (capacity.remaining !== null && capacity.remaining <= 0) return;

    let candidates: Issue[];
    try {
      candidates = await tracker.fetchCandidatePullRequestIssues();
    } catch (err) {
      if (isGithubRateLimitError(err)) throw err;
      log('error', 'pr_review_candidate_fetch_failed', {
        repo_id: this.repoId ?? undefined,
        tracker_kind: config.tracker.kind,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'pr_review_candidate_fetch_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const issue of candidates) {
      if (capacity.remaining !== null && capacity.remaining <= 0) return;
      if (!issue.number) continue;
      if (this.running.has(issue.id)) continue;

      const pr = await tracker.fetchPullRequest(issue.number).catch(() => null);
      if (!pr || pr.is_draft || !pr.head_ref) continue;

      const provider = selectAgentProvider(config, issue);
      if (this.dispatchBlockReason(config, issue, provider, capacity)) continue;

      try {
        await this.dispatchIssue(config, issue, workspaceManager, {
          attempt: 1,
          mode: 'pr-review',
          provider,
          prReview: {
            pr_number: pr.number,
            pr_url: pr.url,
            head_ref: pr.head_ref,
            base_ref: pr.base_ref || 'main',
          },
        });
        if (capacity.remaining !== null) capacity.remaining -= 1;
      } catch (err) {
        log('error', 'pr_review_dispatch_failed', {
          ...getIssueLogFields(config, issue, this.repoId),
          event: 'pr_review_dispatch_failed',
          pr_number: issue.number,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.scheduleRetry(config, issue, 1, 'dispatch_error');
      }
    }
  }

  private shouldSkipConflictResolution(issue: Issue): boolean {
    return issue.labels.includes(LABEL_NEEDS_INFO) || issue.labels.includes('blocked') || issue.labels.includes('wontfix') || issue.labels.includes(LABEL_INTERACTIVE);
  }

  private async processEpicCandidates(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    candidates: Issue[],
  ): Promise<Set<string>> {
    const epicParentIds = new Set<string>();
    for (const issue of candidates) {
      if (!issue.number) continue;
      try {
        const tree = await tracker.buildEpicTree(issue, config.tracker.epics.max_depth);
        if (tree.children.length === 0) continue;

        epicParentIds.add(issue.id);
        await this.coordinateEpic(config, tracker, tree);
      } catch (err) {
        if (isGithubRateLimitError(err)) throw err;
        log('error', 'epic_coordination_failed', {
          ...getIssueLogFields(config, issue, this.repoId),
          event: 'epic_coordination_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return epicParentIds;
  }

  private async coordinateEpic(config: WorkflowConfig, tracker: GithubIssueTrackerClient, tree: EpicTreeNode): Promise<void> {
    const issue = tree.issue;
    if (!issue.number) return;

    const descendants = collectEpicChildren(tree);
    const executionMode = resolveEpicExecutionMode(config, issue);
    const stackPlan = this.buildEpicStackPlan(config, tree, executionMode);
    const existingEpic = (await readEpicStates(config.workspace.root)).find(
      (state) => state.issue_id === issue.id || state.issue_identifier === issue.identifier,
    );
    const children: EpicChildState[] = [];

    for (const entry of descendants) {
      children.push(await this.buildEpicChildState(config, entry.node, entry.depth, stackPlan.get(entry.node.issue.id) ?? null));
    }

    const terminalChildren = descendants.filter((entry) => isTerminalIssue(config, entry.node.issue)).length;
    const totalChildren = descendants.length;
    const openChildren = totalChildren - terminalChildren;
    const isComplete = totalChildren > 0 && openChildren === 0;
    const now = new Date().toISOString();
    const labels = isComplete
      ? issue.labels.filter((label) => label !== LABEL_READY && label !== LABEL_RUNNING).concat(issue.labels.includes(LABEL_READY_FOR_HUMAN) ? [] : [LABEL_READY_FOR_HUMAN])
      : issue.labels;

    const state: EpicState = {
      repo_id: this.repoId,
      owner: config.tracker.owner,
      repo: config.tracker.repo,
      issue_id: issue.id,
      issue_number: issue.number ?? null,
      issue_identifier: issue.identifier,
      issue_url: issue.url ?? null,
      title: issue.title,
      labels: [...new Set(labels)].sort(),
      status: isComplete ? 'completed' : 'coordinating',
      open_children: openChildren,
      terminal_children: terminalChildren,
      total_children: totalChildren,
      children,
      status_comment_id: existingEpic?.status_comment_id ?? null,
      updated_at: now,
    };

    if (isComplete) {
      await this.applyLabels(config, issue.number, { add: [LABEL_READY_FOR_HUMAN], remove: [LABEL_READY, LABEL_RUNNING] });
    }

    const message = isComplete
      ? 'All native sub-issues are terminal. Epic is ready for human review.'
      : 'Epic coordination is active. Symphony queued eligible leaf sub-issues and will keep this parent out of implementation runs.';
    const result = await tracker.upsertStatusComment(issue.number, epicStatusMarker(issue), formatEpicStatusComment({ issue, config, repoId: this.repoId, state, message }), state.status_comment_id);

    await upsertEpicState(config.workspace.root, { ...state, status_comment_id: result.id, updated_at: new Date().toISOString() });
  }

  private buildEpicStackPlan(config: WorkflowConfig, tree: EpicTreeNode, executionMode: EpicExecutionMode): Map<string, EpicStackPlanEntry> {
    const plan = new Map<string, EpicStackPlanEntry>();
    if (executionMode !== 'stacked') return plan;

    const orderedLeaves = leafEpicNodes(tree).filter((node) => node.issue.number && isSameTrackerRepo(config, node.issue));
    let queueUnlocked = true;

    for (const node of orderedLeaves) {
      const issue = node.issue;
      if (this.isStackStageComplete(config, issue)) {
        plan.set(issue.id, { can_queue: false, skipped_reason: null });
        continue;
      }
      if (queueUnlocked) {
        plan.set(issue.id, { can_queue: true, skipped_reason: null });
        queueUnlocked = false;
        continue;
      }
      plan.set(issue.id, { can_queue: false, skipped_reason: 'stack_waiting_on_predecessor' });
    }

    return plan;
  }

  private async buildEpicChildState(
    config: WorkflowConfig,
    node: EpicTreeNode,
    depth: number,
    stackPlan: EpicStackPlanEntry | null,
  ): Promise<EpicChildState> {
    const issue = node.issue;
    const leaf = node.children.length === 0;
    const labels = issue.labels;
    let queued = false;
    let skippedReason: string | null = null;

    if (!leaf) {
      skippedReason = 'nested_epic';
    } else if (!issue.number) {
      skippedReason = 'missing_issue_number';
    } else if (!isSameTrackerRepo(config, issue)) {
      skippedReason = 'cross_repo';
    } else if (isTerminalIssue(config, issue)) {
      skippedReason = 'terminal_state';
    } else if (!config.tracker.active_states.includes(issue.state)) {
      skippedReason = 'inactive_state';
    } else if (hasAnyLabel(labels, config.tracker.ignored_labels)) {
      skippedReason = 'ignored_label';
    } else if (stackPlan && !stackPlan.can_queue) {
      skippedReason = stackPlan.skipped_reason;
    } else if (labels.includes(LABEL_READY) || labels.includes(LABEL_RUNNING)) {
      queued = true;
    } else if (!config.tracker.epics.auto_label_children) {
      skippedReason = 'auto_label_disabled';
    } else {
      try {
        await this.applyLabels(config, issue.number, { add: [LABEL_READY] });
        queued = true;
        labels.push(LABEL_READY);
      } catch (err) {
        skippedReason = 'label_failed';
        log('error', 'epic_child_label_failed', {
          ...getIssueLogFields(config, issue, this.repoId),
          event: 'epic_child_label_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      issue_id: issue.id,
      issue_number: issue.number,
      issue_identifier: issue.identifier,
      issue_url: issue.url,
      title: issue.title,
      state: issue.state,
      labels: [...new Set(labels)].sort(),
      depth,
      leaf,
      queued,
      skipped_reason: skippedReason,
    };
  }

  private async dispatchReadyRetries(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    candidates: Issue[],
    workspaceManager: WorkspaceManager,
    capacity: DispatchCapacity,
  ): Promise<void> {
    const now = nowMs();
    for (const entry of [...this.retries.values()].sort((a, b) => a.next_run_at_ms - b.next_run_at_ms)) {
      if (entry.next_run_at_ms > now) continue;
      const candidate = candidates.find((c) => c.id === entry.issue_id || c.number === entry.issue_number);
      if (!candidate) {
        log('info', 'retry_released', {
          repo_id: this.repoId ?? undefined,
          tracker_kind: config.tracker.kind,
          owner: config.tracker.owner,
          repo: config.tracker.repo,
          event: 'retry_released',
          issue_id: entry.issue_id,
          issue_number: entry.issue_number,
          reason: 'issue_not_candidate',
        });
        this.retries.delete(entry.issue_id);
        continue;
      }

      const provider = selectAgentProvider(config, candidate);
      const blocked = this.dispatchBlockReason(config, candidate, provider, capacity);
      if (blocked === 'global_capacity' || blocked === 'state_capacity') return;
      if (blocked === 'provider_capacity' || blocked === 'usage_limit') continue;
      const stackContext = await this.resolveStackContext(config, tracker, candidate, provider.id);
      if (stackContext?.blocked_reason) continue;
      try {
        await this.dispatchIssue(config, candidate, workspaceManager, { attempt: entry.attempt, provider, stackContext: stackContext?.context ?? null });
        if (capacity.remaining !== null) capacity.remaining -= 1;
      } catch (err) {
        log('error', 'issue_dispatch_failed', {
          ...getIssueLogFields(config, candidate, this.repoId),
          event: 'issue_dispatch_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        await this.scheduleRetry(config, candidate, entry.attempt, 'dispatch_error');
      }
      this.retries.delete(entry.issue_id);
    }
  }

  private async dispatchNewIssues(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    candidates: Issue[],
    workspaceManager: WorkspaceManager,
    capacity: DispatchCapacity,
  ): Promise<void> {
    for (const issue of candidates) {
      const provider = selectAgentProvider(config, issue);
      const blocked = this.dispatchBlockReason(config, issue, provider, capacity);
      if (blocked === 'global_capacity' || blocked === 'state_capacity') return;
      if (blocked === 'provider_capacity' || blocked === 'usage_limit') continue;
      if (this.retries.has(issue.id)) continue;
      const stackContext = await this.resolveStackContext(config, tracker, issue, provider.id);
      if (stackContext?.blocked_reason) continue;
      try {
        await this.dispatchIssue(config, issue, workspaceManager, { attempt: 1, provider, stackContext: stackContext?.context ?? null });
        if (capacity.remaining !== null) capacity.remaining -= 1;
      } catch (err) {
        log('error', 'issue_dispatch_failed', {
          ...getIssueLogFields(config, issue, this.repoId),
          event: 'issue_dispatch_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        await this.scheduleRetry(config, issue, 1, 'dispatch_error');
      }
    }
  }

  private selectWorkspaceStrategy(
    config: WorkflowConfig,
    options: { mode: AgentMode; stackContext: StackContext | null },
  ): WorkspaceStrategy {
    if (options.mode === 'planning') return config.workspace.strategy.planning;
    if (options.mode === 'resolve-conflicts' || options.mode === 'pr-review' || options.mode === 'interactive-handoff') {
      return 'durable_issue_workspace';
    }
    if (options.stackContext) return config.workspace.strategy.epic.stacked;
    return config.workspace.strategy.implementation;
  }

  private async dispatchIssue(
    config: WorkflowConfig,
    issue: Issue,
    workspaceManager: WorkspaceManager,
    opts: {
      attempt: number;
      mode?: AgentMode;
      provider?: AgentProviderConfig;
      conflict?: ConflictDispatchOptions;
      prReview?: PullRequestReviewDispatchOptions;
      stackContext?: StackContext | null;
    },
  ): Promise<void> {
    if (!issue.number) throw new SymphonyConfigError('issue.number is required to dispatch work');
    const provider = opts.provider ?? selectAgentProvider(config, issue);
    const stackContext = opts.stackContext ?? null;
    const issueFields = getIssueLogFields(config, issue, this.repoId);
    const isConflictResolution = opts.mode === 'resolve-conflicts';
    const isPullRequestReview = opts.mode === 'pr-review';
    const isInteractiveHandoff = !isConflictResolution && !isPullRequestReview && issue.labels.includes(LABEL_INTERACTIVE);
    const isPlanningRun = !isConflictResolution && !isPullRequestReview && !isInteractiveHandoff && isPlanningIssue(issue.labels);
    const agentMode: AgentMode = isConflictResolution
      ? 'resolve-conflicts'
      : isPullRequestReview
        ? 'pr-review'
        : isInteractiveHandoff
          ? 'interactive-handoff'
          : isPlanningRun
            ? 'planning'
            : 'autonomous';
    const workspaceStrategy = this.selectWorkspaceStrategy(config, {
      mode: agentMode,
      stackContext,
    });

    log('info', 'issue_claimed', { ...issueFields, event: 'issue_claimed', status: 'claimed', agent_provider: provider.id });

    const { workspace_path: workspacePath, is_new: isNew } = await workspaceManager.ensureWorkspace(issue, {
      strategy: workspaceStrategy,
      epicRootIssueIdentifier: stackContext?.root_issue_identifier ?? null,
    });
    const workspaceFields = { ...issueFields, workspace_path: workspacePath };
    const hookSymphonyContext = {
      workspace_path: workspacePath,
      workspace_strategy: workspaceStrategy,
      agent_provider: provider.id,
      agent_provider_group: provider.provider_group,
      agent_provider_kind: provider.provider_kind,
      stack_root_issue_identifier: stackContext?.root_issue_identifier ?? '',
      stack_root_issue_number: stackContext?.root_issue_number ?? '',
      stack_predecessor_issue_identifier: stackContext?.predecessor_issue_identifier ?? '',
      stack_predecessor_issue_number: stackContext?.predecessor_issue_number ?? '',
      stack_base_branch: stackContext?.base_branch ?? '',
      stack_predecessor_thread_id: stackContext?.reusable_thread_id ?? '',
      stack_position: stackContext?.position ?? '',
      stack_total: stackContext?.total ?? '',
    };
    const hookEnv: Record<string, string> = {
      SYMPHONY_REPO_ID: this.repoId ?? '',
      SYMPHONY_TRACKER_OWNER: config.tracker.owner,
      SYMPHONY_TRACKER_REPO: config.tracker.repo,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_NUMBER: String(issue.number ?? ''),
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHONY_ISSUE_URL: issue.url ?? '',
      SYMPHONY_WORKSPACE_PATH: workspacePath,
      SYMPHONY_WORKSPACE_STRATEGY: workspaceStrategy,
      SYMPHONY_BRANCH_NAME: issue.branch_name ?? '',
      SYMPHONY_AGENT_PROVIDER: provider.id,
      SYMPHONY_AGENT_PROVIDER_GROUP: provider.provider_group,
      SYMPHONY_AGENT_PROVIDER_KIND: provider.provider_kind,
      SYMPHONY_STACK_ROOT_ISSUE_IDENTIFIER: stackContext?.root_issue_identifier ?? '',
      SYMPHONY_STACK_ROOT_ISSUE_NUMBER: String(stackContext?.root_issue_number ?? ''),
      SYMPHONY_STACK_PREDECESSOR_ISSUE_IDENTIFIER: stackContext?.predecessor_issue_identifier ?? '',
      SYMPHONY_STACK_PREDECESSOR_ISSUE_NUMBER: String(stackContext?.predecessor_issue_number ?? ''),
      SYMPHONY_STACK_BASE_BRANCH: stackContext?.base_branch ?? '',
      SYMPHONY_STACK_PREDECESSOR_THREAD_ID: stackContext?.reusable_thread_id ?? '',
      SYMPHONY_STACK_POSITION: String(stackContext?.position ?? ''),
      SYMPHONY_STACK_TOTAL: String(stackContext?.total ?? ''),
    };

    const skipsWorkspaceHooks = workspaceStrategy === 'none_or_readonly';
    const hasGitRepo = skipsWorkspaceHooks ? false : await workspaceManager.hasGitRepo(workspacePath);
    const shouldRunAfterCreate = !skipsWorkspaceHooks && Boolean(config.hooks.after_create) && (isNew || !hasGitRepo);

    if (shouldRunAfterCreate && config.hooks.after_create) {
      if (!isNew && !hasGitRepo) {
        const isEmpty = await workspaceManager.isWorkspaceEmpty(workspacePath);
        if (!isEmpty) {
          log('warn', 'workspace_clearing_uninitialized', {
            ...workspaceFields,
            event: 'workspace_clearing_uninitialized',
            reason: 'missing_git_repo',
          });
          await workspaceManager.clearWorkspaceContents(workspacePath);
          log('info', 'workspace_cleared_uninitialized', { ...workspaceFields, event: 'workspace_cleared_uninitialized' });
        }
      }

      log('info', 'workspace_after_create_hook_started', { ...workspaceFields, event: 'workspace_after_create_hook_started' });
      const rendered = await renderTemplate(config.hooks.after_create, { issue, symphony: hookSymphonyContext });
      await runHookScript(rendered, workspacePath, config.hooks.timeout_ms, hookEnv);
      log('info', 'workspace_after_create_hook_completed', { ...workspaceFields, event: 'workspace_after_create_hook_completed' });
    }

    const previousWorkspaceState = await readRunState(workspacePath);
    const existingState =
      previousWorkspaceState?.issue_id === issue.id || previousWorkspaceState?.issue_number === issue.number
        ? previousWorkspaceState
        : null;
    const isPausedResume = existingState?.status === 'paused';

    const hasGitRepoBeforeRun = skipsWorkspaceHooks ? false : await workspaceManager.hasGitRepo(workspacePath);
    if (hasGitRepoBeforeRun && !isPausedResume) {
      const recovery = await recoverFreshRunGitState(workspacePath);
      if (recovery.recovered) {
        log('warn', 'workspace_git_state_recovered', {
          ...workspaceFields,
          event: 'workspace_git_state_recovered',
          reason: 'unresolved_index',
          unmerged_files: recovery.unmerged_files,
        });
      }
    }

    if (config.hooks.before_run && !isPausedResume && !skipsWorkspaceHooks) {
      log('info', 'workspace_before_run_hook_started', { ...workspaceFields, event: 'workspace_before_run_hook_started' });
      const rendered = await renderTemplate(config.hooks.before_run, { issue, symphony: hookSymphonyContext });
      await runHookScript(rendered, workspacePath, config.hooks.timeout_ms, hookEnv);
      log('info', 'workspace_before_run_hook_completed', { ...workspaceFields, event: 'workspace_before_run_hook_completed' });
    } else if (config.hooks.before_run && isPausedResume) {
      log('info', 'workspace_before_run_hook_skipped', {
        ...workspaceFields,
        event: 'workspace_before_run_hook_skipped',
        reason: 'paused_resume_preserves_workspace',
      });
    } else if (config.hooks.before_run && skipsWorkspaceHooks) {
      log('info', 'workspace_before_run_hook_skipped', {
        ...workspaceFields,
        event: 'workspace_before_run_hook_skipped',
        reason: 'workspace_strategy_none_or_readonly',
      });
    }

    let conflictBriefPath: string | null = null;
    if (opts.mode === 'resolve-conflicts' && opts.conflict) {
      conflictBriefPath = await this.prepareConflictResolutionWorkspace(workspacePath, opts.conflict);
    }
    if (opts.mode === 'pr-review' && opts.prReview) {
      await this.preparePullRequestReviewWorkspace(workspacePath, opts.prReview);
    }

    const comments = await new GithubIssueTrackerClient(config.tracker).listIssueComments(issue.number);
    let pullRequestReviewComments: IssueComment[] = [];
    if (opts.mode === 'pr-review' && opts.prReview) {
      pullRequestReviewComments = await new GithubIssueTrackerClient(config.tracker).listPullRequestReviewComments(opts.prReview.pr_number);
    }
    const lastMessagePath = path.join(workspacePath, '.symphony', 'last_message.md');
    const runContext = await buildRunContext({
      workspacePath,
      comments,
      lastSeenCommentId: existingState?.last_seen_comment_id ?? null,
      pullRequestReviewComments,
      lastSeenPullRequestReviewCommentId: existingState?.last_seen_pr_review_comment_id ?? null,
      lastMessagePath: existingState?.last_message_path ?? lastMessagePath,
    });

    const handoffInstructions = isInteractiveHandoff
      ? '\n\n---\n\n## Interactive Handoff Instructions\n\nCreate a concise orientation summary for the user to continue this issue interactively. Do not edit files, run write commands, commit, push, or open a PR in this handoff pass.\n'
      : '';
    const planningInstructions = isPlanningRun
      ? '\n\n---\n\n## Planning / Technical Specification Instructions\n\nThis is a planning-only Symphony run. These instructions supersede any workflow instructions that ask you to edit files, commit, push, or open a pull request.\n\n- Inspect the repository and issue context enough to produce a concrete technical specification.\n- Do not edit files, run write commands, commit, push, create branches, or open a pull request.\n- Write the final answer as a detailed technical specification suitable for the issue thread.\n- Include: problem statement, relevant existing code/architecture, proposed implementation, files likely to change, API/data model implications, UX implications when relevant, test plan, risks, open questions, and suggested implementation tickets if the work should be split.\n- If implementation needs a product, architecture, security, data-loss, cost, or irreversible decision, use the SYMPHONY_PAUSE protocol instead of guessing.\n'
      : '';
    const pullRequestReviewInstructions =
      isPullRequestReview && opts.prReview
        ? `\n\n---\n\n## Pull Request Review Instructions\n\nYou are addressing review feedback on PR #${opts.prReview.pr_number}${opts.prReview.pr_url ? ` (${opts.prReview.pr_url})` : ''}.\n\n- The workspace has been checked out to the PR head branch \`${opts.prReview.head_ref}\`.\n- Address the new PR review comments and PR conversation comments included in the run context.\n- Commit changes to the existing PR branch and push back to origin.\n- Do not open a replacement PR.\n`
        : '';
    const stackInstructions = stackContext ? this.formatStackInstructions(stackContext) : '';
    const symphonyContext = {
      prompt_path: '',
      workspace_path: workspacePath,
      workspace_strategy: workspaceStrategy,
      agent_provider: provider.id,
      agent_provider_group: provider.provider_group,
      agent_provider_kind: provider.provider_kind,
      agent_thread_id: '',
      codex_thread_id: '',
      stack_root_issue_identifier: stackContext?.root_issue_identifier ?? '',
      stack_root_issue_number: stackContext?.root_issue_number ?? '',
      stack_predecessor_issue_identifier: stackContext?.predecessor_issue_identifier ?? '',
      stack_predecessor_issue_number: stackContext?.predecessor_issue_number ?? '',
      stack_base_branch: stackContext?.base_branch ?? '',
      stack_predecessor_thread_id: stackContext?.reusable_thread_id ?? '',
      stack_position: stackContext?.position ?? '',
      stack_total: stackContext?.total ?? '',
    };
    const prompt = isConflictResolution && opts.conflict
      ? this.formatConflictResolutionPrompt(
          issue,
          opts.conflict,
          conflictBriefPath ?? path.join(workspacePath, '.symphony', 'merge-conflict.md'),
          runContext.text,
        )
      : `${await renderPrompt(this.lastGoodWorkflow?.prompt_template ?? '', issue, { symphony: symphonyContext })}${runContext.text}${stackInstructions}${handoffInstructions}${planningInstructions}${pullRequestReviewInstructions}`;
    const promptPath = await workspaceManager.writePrompt(workspacePath, prompt);
    const agentLogPath = resolveAgentLogPath(workspacePath, provider);
    await fs.mkdir(path.dirname(agentLogPath), { recursive: true });
    const codexCompatible = isCodexProvider(provider);
    const codexJsonlPath = codexCompatible ? agentLogPath : path.join(workspacePath, '.symphony', 'codex.jsonl');

    let agentThreadId =
      existingState?.agent_provider === provider.id
        ? existingState?.agent_thread_id ?? existingState?.codex_thread_id ?? null
        : provider.id === 'codex'
          ? existingState?.codex_thread_id ?? null
          : null;
    if (!agentThreadId && codexCompatible) agentThreadId = stackContext?.reusable_thread_id ?? null;
    let codexThreadId = codexCompatible ? agentThreadId : null;
    const pauseReason: PauseReason = isInteractiveHandoff ? 'interactive' : null;
    const commandTemplate = isInteractiveHandoff || isPlanningRun
      ? provider.handoff_command ?? provider.command
      : agentThreadId && provider.resume_command
        ? provider.resume_command
        : provider.command;
    symphonyContext.prompt_path = promptPath;
    symphonyContext.agent_thread_id = agentThreadId ?? '';
    symphonyContext.codex_thread_id = codexThreadId ?? '';
    const renderedCommand = await renderTemplate(commandTemplate, {
      issue,
      symphony: symphonyContext,
    });

    const env: Record<string, string> = {
      ...hookEnv,
      SYMPHONY_PROMPT_PATH: promptPath,
      SYMPHONY_AGENT_THREAD_ID: agentThreadId ?? '',
      SYMPHONY_CODEX_THREAD_ID: codexThreadId ?? '',
    };

    const statusCommentId = existingState?.status_comment_id ?? null;
    const initialState: RunState = {
      repo_id: this.repoId,
      owner: config.tracker.owner,
      repo: config.tracker.repo,
      issue_id: issue.id,
      issue_number: issue.number ?? null,
      issue_identifier: issue.identifier,
      issue_url: issue.url ?? null,
      labels: issue.labels,
      workflow_state: issue.workflow_state,
      workspace_path: workspacePath,
      workspace_strategy: workspaceStrategy,
      attempt: opts.attempt,
      session_id: null,
      agent_provider: provider.id,
      agent_provider_group: provider.provider_group,
      agent_provider_kind: provider.provider_kind,
      agent_thread_id: agentThreadId,
      agent_mode: agentMode,
      agent_log_path: agentLogPath,
      codex_thread_id: codexThreadId,
      codex_mode: codexCompatible ? agentMode : null,
      pause_reason: pauseReason,
      worker_pid: null,
      status: 'running',
      started_at: new Date().toISOString(),
      finished_at: null,
      last_exit_code: null,
      last_signal: null,
      last_error: null,
      prompt_path: promptPath,
      agent_output_path: agentLogPath,
      codex_jsonl_path: codexCompatible ? codexJsonlPath : existingState?.codex_jsonl_path ?? null,
      last_message_path: lastMessagePath,
      last_seen_comment_id: runContext.lastSeenCommentId,
      last_seen_pr_review_comment_id: runContext.lastSeenPullRequestReviewCommentId,
      status_comment_id: statusCommentId,
      last_handoff_at: isInteractiveHandoff ? new Date().toISOString() : existingState?.last_handoff_at ?? null,
      updated_at: new Date().toISOString(),
    };

    await writeRunState(workspacePath, initialState);

    try {
      if (isInteractiveHandoff) {
        await this.applyLabels(config, issue.number, { remove: [LABEL_READY, LABEL_RUNNING] });
        await this.updateLifecycleState(workspacePath, { remove: [LABEL_READY, LABEL_RUNNING], workflowState: 'interactive' });
        await this.upsertStatus(config, issue, initialState, `Interactive handoff requested. Preparing a ${provider.id} session and pausing autonomous work.`);
      } else if (isPlanningRun) {
        await this.applyLabels(config, issue.number, { add: [LABEL_RUNNING], remove: [LABEL_READY, LABEL_NEEDS_INFO] });
        await this.updateLifecycleState(workspacePath, { add: [LABEL_RUNNING], remove: [LABEL_READY, LABEL_NEEDS_INFO], workflowState: LABEL_RUNNING });
        await this.upsertStatus(config, issue, initialState, `Planning run requested. Symphony is starting ${provider.id} in spec-only mode and will post the plan to this issue.`);
      } else if (isConflictResolution) {
        await this.applyLabels(config, issue.number, { add: [LABEL_RUNNING], remove: [LABEL_READY, LABEL_READY_FOR_HUMAN, LABEL_NEEDS_INFO] });
        await this.updateLifecycleState(workspacePath, {
          add: [LABEL_RUNNING],
          remove: [LABEL_READY, LABEL_READY_FOR_HUMAN, LABEL_NEEDS_INFO],
          workflowState: LABEL_RUNNING,
        });
        await this.upsertStatus(config, issue, initialState, `Merge conflicts detected for PR #${opts.conflict?.pr_number}. Symphony is starting ${provider.id} conflict-resolution mode.`);
      } else if (isPullRequestReview) {
        await this.applyLabels(config, issue.number, { add: [LABEL_RUNNING], remove: [LABEL_READY, LABEL_READY_FOR_HUMAN, LABEL_NEEDS_INFO] });
        await this.updateLifecycleState(workspacePath, {
          add: [LABEL_RUNNING],
          remove: [LABEL_READY, LABEL_READY_FOR_HUMAN, LABEL_NEEDS_INFO],
          workflowState: LABEL_RUNNING,
        });
        await this.upsertStatus(config, issue, initialState, `PR review feedback is ready. Symphony is starting ${provider.id} on PR #${opts.prReview?.pr_number}.`);
      } else {
        await this.applyLabels(config, issue.number, { add: [LABEL_RUNNING], remove: [LABEL_READY, LABEL_NEEDS_INFO] });
        await this.updateLifecycleState(workspacePath, { add: [LABEL_RUNNING], remove: [LABEL_READY, LABEL_NEEDS_INFO], workflowState: LABEL_RUNNING });
        await this.upsertStatus(config, issue, initialState, `Claimed by Symphony. Autonomous ${provider.id} run is starting.`);
      }
    } catch (err) {
      await this.applyLabels(config, issue.number, { add: [LABEL_READY], remove: [LABEL_RUNNING] }).catch(() => {});
      await this.updateLifecycleState(workspacePath, { add: [LABEL_READY], remove: [LABEL_RUNNING], workflowState: LABEL_READY }).catch(() => {});
      await updateRunState(workspacePath, (cur) =>
        cur
          ? {
              ...cur,
              status: 'failed',
              finished_at: new Date().toISOString(),
              last_error: err instanceof Error ? err.message : String(err),
              updated_at: new Date().toISOString(),
            }
          : null,
      );
      throw err;
    }

    log('info', 'issue_dispatched', { ...workspaceFields, event: 'issue_dispatched', status: 'dispatched' });

    const agent = runAgent({
      command: renderedCommand,
      cwd: workspacePath,
      env,
      turnTimeoutMs: provider.turn_timeout_ms,
      logFields: { ...workspaceFields, event: 'worker_started', status: 'running', attempt: opts.attempt, agent_provider: provider.id },
      onStdoutLine: (line) => {
        if (!provider.extract_codex_thread_id) return;
        const threadId = extractCodexThreadId(line);
        if (!threadId || threadId === agentThreadId) return;
        agentThreadId = threadId;
        codexThreadId = codexCompatible ? threadId : codexThreadId;
        void updateRunState(workspacePath, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            agent_thread_id: threadId,
            codex_thread_id: codexCompatible ? threadId : cur.codex_thread_id,
            updated_at: new Date().toISOString(),
          };
        });
      },
    });

    await updateRunState(workspacePath, (cur) => {
      if (!cur) return null;
      return {
        ...cur,
        session_id: agent.session_id,
        worker_pid: agent.child.pid ?? null,
        updated_at: new Date().toISOString(),
      };
    });

    const session: RunningSession = {
      issue_id: issue.id,
      issue_number: issue.number ?? -1,
      issue_identifier: issue.identifier,
      issue_url: issue.url ?? null,
      issue_state: isConflictResolution ? 'conflict-resolution' : issue.state,
      workspace_path: workspacePath,
      session_id: agent.session_id,
      agent_provider: provider.id,
      agent_provider_group: provider.provider_group,
      started_at_ms: nowMs(),
      cancelled_reason: null,
      cancel: agent.cancel,
      done: null,
    };

    this.running.set(issue.id, session);

    const done = agent.exit
      .then(async ({ code, signal }) => {
        const endFields = { ...workspaceFields, session_id: agent.session_id };
        this.running.delete(issue.id);
        const cancelledReason = session.cancelled_reason;
        await updateRunState(workspacePath, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: cancelledReason ? 'cancelled' : code === 0 && !signal ? 'completed' : 'failed',
            finished_at: new Date().toISOString(),
            last_exit_code: code ?? null,
            last_signal: signal ?? null,
            updated_at: new Date().toISOString(),
          };
        });

        if (cancelledReason) {
          log('info', 'worker_cancelled', {
            ...endFields,
            event: 'worker_cancelled',
            status: 'cancelled',
            reason: cancelledReason,
            signal,
          });
          if (shouldRetryCancelledRun(cancelledReason)) {
            await this.applyLabels(config, issue.number!, { add: [LABEL_READY], remove: [LABEL_RUNNING] });
            await this.updateLifecycleState(workspacePath, { add: [LABEL_READY], remove: [LABEL_RUNNING], workflowState: LABEL_READY });
            await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), 'Autonomous run was interrupted. Symphony will retry.');
            await this.scheduleRetry(config, issue, opts.attempt, 'cancelled', workspacePath);
          }
          return;
        }

        if (signal) {
          log('error', 'worker_failed', { ...endFields, event: 'worker_failed', status: 'failed', signal });
          await this.applyLabels(config, issue.number!, { add: [LABEL_READY], remove: [LABEL_RUNNING] });
          await this.updateLifecycleState(workspacePath, { add: [LABEL_READY], remove: [LABEL_RUNNING], workflowState: LABEL_READY });
          await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), `Autonomous run stopped with signal ${signal}. Symphony will retry.`);
          await this.scheduleRetry(config, issue, opts.attempt, 'signal_exit', workspacePath);
          return;
        }

        if (code === 0) {
          log('info', 'worker_completed', { ...endFields, event: 'worker_completed', status: 'completed', code });
          if (isInteractiveHandoff) {
            await this.pauseForInteractive(config, issue, workspacePath, 'Interactive handoff is ready.');
            return;
          }

          const latestIssue = issue.number ? await new GithubIssueTrackerClient(config.tracker).fetchIssueByNumber(issue.number) : null;
          if (latestIssue?.labels.includes(LABEL_INTERACTIVE)) {
            await this.pauseForInteractive(config, latestIssue, workspacePath, 'Interactive label detected after the autonomous run completed.');
            return;
          }

          const pauseRequest = parsePauseRequest(await this.readLastMessage(lastMessagePath));
          if (pauseRequest) {
            await new GithubIssueTrackerClient(config.tracker).createIssueComment(issue.number!, formatPauseComment(pauseRequest));
            await this.applyLabels(config, issue.number!, { add: [LABEL_NEEDS_INFO], remove: [LABEL_READY, LABEL_RUNNING] });
            await this.updateLifecycleState(workspacePath, {
              add: [LABEL_NEEDS_INFO],
              remove: [LABEL_READY, LABEL_RUNNING],
              workflowState: LABEL_NEEDS_INFO,
            });
            await updateRunState(workspacePath, (cur) =>
              cur ? { ...cur, status: 'paused', pause_reason: 'needs-info', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() } : null,
            );
            await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), 'Paused for user input. Symphony posted a question on this issue.');
            return;
          }

          if (isPlanningRun) {
            await this.postPlanningResult(config, issue, workspacePath, lastMessagePath);
            await this.applyLabels(config, issue.number!, { add: [LABEL_READY_FOR_HUMAN], remove: [LABEL_READY, LABEL_RUNNING] });
            await this.updateLifecycleState(workspacePath, {
              add: [LABEL_READY_FOR_HUMAN],
              remove: [LABEL_READY, LABEL_RUNNING],
              workflowState: LABEL_READY_FOR_HUMAN,
            });
            await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), 'Planning run completed. Symphony posted the technical specification to this issue.');
            return;
          }

          if (config.hooks.after_run) {
            log('info', 'workspace_after_run_hook_started', { ...endFields, event: 'workspace_after_run_hook_started' });
            try {
              const rendered = await renderTemplate(config.hooks.after_run, { issue, symphony: hookSymphonyContext });
              await runHookScript(rendered, workspacePath, config.hooks.timeout_ms, env);
              log('info', 'workspace_after_run_hook_completed', { ...endFields, event: 'workspace_after_run_hook_completed' });
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              log('error', 'workspace_after_run_hook_failed', {
                ...endFields,
                event: 'workspace_after_run_hook_failed',
                error,
              });
              await updateRunState(workspacePath, (cur) =>
                cur
                  ? {
                      ...cur,
                      status: 'failed',
                      last_error: `after_run hook failed: ${error}`,
                      updated_at: new Date().toISOString(),
                    }
                  : null,
              );
              await this.applyLabels(config, issue.number!, { add: [LABEL_READY], remove: [LABEL_RUNNING] });
              await this.updateLifecycleState(workspacePath, { add: [LABEL_READY], remove: [LABEL_RUNNING], workflowState: LABEL_READY });
              await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), `Post-run validation failed: ${error}. Symphony will retry.`);
              await this.scheduleRetry(config, issue, opts.attempt, 'after_run_failed', workspacePath);
              return;
            }
          }

          if (!isConflictResolution && !isPullRequestReview) {
            const dirtyPr = await this.findDirtyPullRequestForIssue(config, issue);
            if (dirtyPr) {
              this.conflictQueue.set(dirtyPr.number, {
                pr_number: dirtyPr.number,
                issue_number: issue.number!,
                head_ref: dirtyPr.head_ref,
                base_ref: dirtyPr.base_ref || 'main',
                url: dirtyPr.url,
                next_run_at_ms: nowMs(),
              });
              await this.applyLabels(config, issue.number!, { add: [LABEL_READY], remove: [LABEL_RUNNING] });
              await this.updateLifecycleState(workspacePath, { add: [LABEL_READY], remove: [LABEL_RUNNING], workflowState: LABEL_READY });
              await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), `PR #${dirtyPr.number} has merge conflicts. Symphony queued conflict-resolution mode.`);
              return;
            }
          }

          if (!isConflictResolution && !isPullRequestReview) {
            const pr = await this.findPullRequestForIssue(config, issue).catch(() => null);
            if (pr) {
              await this.applyLabels(config, pr.number, { add: [LABEL_READY_FOR_HUMAN], remove: [LABEL_READY, LABEL_RUNNING] }).catch((err) => {
                log('error', 'pr_ready_for_human_label_failed', {
                  ...getIssueLogFields(config, issue, this.repoId),
                  event: 'pr_ready_for_human_label_failed',
                  pr_number: pr.number,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          }

          await this.applyLabels(config, issue.number!, { add: [LABEL_READY_FOR_HUMAN], remove: [LABEL_READY, LABEL_RUNNING] });
          await this.updateLifecycleState(workspacePath, {
            add: [LABEL_READY_FOR_HUMAN],
            remove: [LABEL_READY, LABEL_RUNNING],
            workflowState: LABEL_READY_FOR_HUMAN,
          });
          await this.upsertStatus(
            config,
            issue,
            await this.mustReadRunState(workspacePath),
            isPullRequestReview ? 'PR review feedback addressed. PR is ready for human review.' : 'Autonomous run completed. Issue is ready for human review.',
          );
          return;
        }

        log('error', 'worker_failed', { ...endFields, event: 'worker_failed', status: 'failed', code });
        await this.applyLabels(config, issue.number!, { add: [LABEL_READY], remove: [LABEL_RUNNING] });
        await this.updateLifecycleState(workspacePath, { add: [LABEL_READY], remove: [LABEL_RUNNING], workflowState: LABEL_READY });

        if (code !== null && provider.usage_limit_exit_codes?.includes(code) && provider.usage_limit_backoff_ms > 0) {
          const limitKey = providerLimitKey(provider);
          const backoffUntil = nowMs() + provider.usage_limit_backoff_ms;
          const backoffSeconds = Math.round(provider.usage_limit_backoff_ms / 1000);
          this.providerUsageLimitBackoffUntil.set(limitKey, backoffUntil);
          log('warn', 'provider_usage_limit_backoff', {
            ...endFields,
            event: 'provider_usage_limit_backoff',
            agent_provider: provider.id,
            agent_provider_group: limitKey,
            exit_code: code,
            backoff_ms: provider.usage_limit_backoff_ms,
            backoff_until: new Date(backoffUntil).toISOString(),
          });
          await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), `Usage limit reached for ${provider.id} (exit code ${code}). Symphony will pause new ${limitKey} dispatches for ${backoffSeconds}s and retry.`);
        } else {
          await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), `Autonomous run failed with exit code ${code}. Symphony will retry.`);
        }
        await this.scheduleRetry(config, issue, opts.attempt, 'nonzero_exit', workspacePath);
      })
      .catch(async (err) => {
        const endFields = { ...workspaceFields, session_id: agent.session_id };
        this.running.delete(issue.id);
        await updateRunState(workspacePath, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: 'failed',
            finished_at: new Date().toISOString(),
            last_exit_code: null,
            last_signal: null,
            last_error: err instanceof Error ? err.message : String(err),
            updated_at: new Date().toISOString(),
          };
        });
        log('error', 'worker_failed', {
          ...endFields,
          event: 'worker_failed',
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        if (issue.number) {
          await this.applyLabels(config, issue.number, { add: [LABEL_READY], remove: [LABEL_RUNNING] })
            .then(() => this.updateLifecycleState(workspacePath, { add: [LABEL_READY], remove: [LABEL_RUNNING], workflowState: LABEL_READY }))
            .catch(() => {});
        }
        await this.scheduleRetry(config, issue, opts.attempt, 'runner_error', workspacePath);
      });

    session.done = done;
  }

  private async prepareConflictResolutionWorkspace(workspacePath: string, conflict: ConflictDispatchOptions): Promise<string> {
    const symphonyDir = path.join(workspacePath, '.symphony');
    await fs.mkdir(symphonyDir, { recursive: true });
    const briefPath = path.join(symphonyDir, 'merge-conflict.md');

    await runGit(workspacePath, ['fetch', 'origin']);
    await runGit(workspacePath, ['checkout', '-B', conflict.head_ref, `origin/${conflict.head_ref}`]);

    let mergeError: string | null = null;
    try {
      await runGit(workspacePath, ['merge', '--no-edit', `origin/${conflict.base_ref}`]);
      await runGit(workspacePath, ['push', 'origin', `HEAD:${conflict.head_ref}`]);
    } catch (err) {
      mergeError = err instanceof Error ? err.message : String(err);
    }

    const conflictedFiles = await runGit(workspacePath, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    const status = await runGit(workspacePath, ['status', '--short']).catch((err) => (err instanceof Error ? err.message : String(err)));
    const currentBranch = await runGit(workspacePath, ['branch', '--show-current']).catch(() => conflict.head_ref);
    const brief = [
      `# Symphony Merge Conflict`,
      ``,
      `PR: #${conflict.pr_number}${conflict.pr_url ? ` (${conflict.pr_url})` : ''}`,
      `Branch: ${conflict.head_ref}`,
      `Base: ${conflict.base_ref}`,
      `Current branch: ${currentBranch || '(unknown)'}`,
      ``,
      mergeError ? `Merge command failed while merging origin/${conflict.base_ref}:` : `origin/${conflict.base_ref} merged cleanly and the branch was pushed.`,
      mergeError ? `\n\`\`\`text\n${mergeError}\n\`\`\`` : '',
      ``,
      `## Conflicted Files`,
      conflictedFiles || '(none)',
      ``,
      `## Git Status`,
      `\`\`\`text`,
      status || '(clean)',
      `\`\`\``,
      ``,
    ].join('\n');
    await fs.writeFile(briefPath, brief, 'utf8');
    return briefPath;
  }

  private async preparePullRequestReviewWorkspace(workspacePath: string, pr: PullRequestReviewDispatchOptions): Promise<void> {
    await runGit(workspacePath, ['fetch', 'origin', pr.head_ref]);
    await runGit(workspacePath, ['checkout', '-B', pr.head_ref, 'FETCH_HEAD']);
  }

  private formatConflictResolutionPrompt(issue: Issue, conflict: ConflictDispatchOptions, briefPath: string, runContext: string): string {
    return `You are resolving merge conflicts for ${issue.identifier}.

The pull request branch has conflicts with its base branch.

PR: #${conflict.pr_number}${conflict.pr_url ? ` (${conflict.pr_url})` : ''}
Branch: ${conflict.head_ref}
Base branch: ${conflict.base_ref}
Conflict brief: ${briefPath}

Goal:
Resolve the conflicts from merging origin/${conflict.base_ref} into ${conflict.head_ref}.

Rules:
- Treat this as conflict-resolution work, not a fresh implementation pass.
- Preserve the intent of both ${conflict.head_ref} and origin/${conflict.base_ref}.
- Read .symphony/merge-conflict.md before editing.
- Resolve all conflicted files.
- Run targeted checks for the affected files when practical.
- Commit the merge resolution.
- Push ${conflict.head_ref}.
- Verify PR #${conflict.pr_number} is no longer dirty if GitHub reports mergeability.
- If a product or code-ownership decision is needed, use SYMPHONY_PAUSE and list the conflicted files.

${runContext}`;
  }

  private formatStackInstructions(stack: StackContext): string {
    const lines = [
      '',
      '---',
      '',
      '## Stacked Epic Context',
      '',
      `This issue is step ${stack.position} of ${stack.total} in the native sub-issue stack rooted at ${stack.root_issue_identifier}.`,
      '- Keep this issue in its own commit(s) and its own PR.',
      '- Do not fold predecessor issue scope into this issue.',
    ];

    if (stack.base_branch) {
      lines.push(`- Open this issue's PR against \`${stack.base_branch}\` instead of \`main\`.`);
    }
    if (stack.predecessor_issue_identifier) {
      lines.push(`- The immediate predecessor issue is ${stack.predecessor_issue_identifier}. Reuse that context, but keep the PR separate.`);
    }
    if (stack.predecessor_last_message) {
      lines.push('', 'Previous stack step final message:', '```text', stack.predecessor_last_message.trim(), '```');
    }

    return `${lines.join('\n')}\n`;
  }

  private isStackStageComplete(config: WorkflowConfig, issue: Issue): boolean {
    return isTerminalIssue(config, issue) || issue.labels.includes(LABEL_READY_FOR_HUMAN);
  }

  private async findEpicRootIssue(
    tracker: GithubIssueTrackerClient,
    issue: Issue,
    maxDepth: number,
  ): Promise<Issue | null> {
    if (!issue.number) return null;
    let current: Issue | null = issue;
    let root: Issue | null = null;

    for (let depth = 0; depth < maxDepth && current?.number; depth += 1) {
      const parent: Issue | null = await tracker.getParentIssue(current.number).catch(() => null);
      if (!parent) break;
      root = parent;
      current = parent;
    }

    return root;
  }

  private async readRunStateForIssue(config: WorkflowConfig, issue: Issue): Promise<RunState | null> {
    const workspacePath = workspacePathForIssue(config.workspace.root, issue);
    const state = await readRunState(workspacePath);
    if (state) return state;
    const states = await scanRunStates(config.workspace.root);
    return states.find((candidate) => candidate.issue_id === issue.id || candidate.issue_number === issue.number) ?? null;
  }

  private async readTextFile(pathname: string | null | undefined, maxChars: number): Promise<string | null> {
    if (!pathname) return null;
    try {
      const raw = await fs.readFile(pathname, 'utf8');
      const text = raw.slice(-maxChars).trim();
      return text || null;
    } catch {
      return null;
    }
  }

  private async resolveStackContext(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    issue: Issue,
    providerId: string,
  ): Promise<{ context: StackContext | null; blocked_reason: string | null } | null> {
    if (!issue.number) return null;

    const root = await this.findEpicRootIssue(tracker, issue, config.tracker.epics.max_depth);
    if (!root) return null;
    if (resolveEpicExecutionMode(config, root) !== 'stacked') return null;

    const tree = await tracker.buildEpicTree(root, config.tracker.epics.max_depth);
    const orderedLeaves = leafEpicNodes(tree).filter((node) => node.issue.number && isSameTrackerRepo(config, node.issue));
    const position = orderedLeaves.findIndex((node) => node.issue.id === issue.id || node.issue.number === issue.number);
    if (position === -1) return null;

    for (let index = 0; index < position; index += 1) {
      if (!this.isStackStageComplete(config, orderedLeaves[index]!.issue)) {
        return { context: null, blocked_reason: 'stack_waiting_on_predecessor' };
      }
    }

    const predecessorIssue = position > 0 ? orderedLeaves[position - 1]!.issue : null;
    const predecessorState = predecessorIssue ? await this.readRunStateForIssue(config, predecessorIssue) : null;
    const reusableThreadId =
      predecessorState && predecessorState.agent_provider === providerId
        ? predecessorState.agent_thread_id ?? predecessorState.codex_thread_id ?? null
        : null;
    const predecessorLastMessage = await this.readTextFile(predecessorState?.last_message_path, 8_000);

    return {
      blocked_reason: null,
      context: {
        root_issue_identifier: root.identifier,
        root_issue_number: root.number ?? null,
        predecessor_issue_identifier: predecessorIssue?.identifier ?? null,
        predecessor_issue_number: predecessorIssue?.number ?? null,
        base_branch:
          predecessorIssue && predecessorIssue.number && !isTerminalIssue(config, predecessorIssue)
            ? predecessorIssue.branch_name ?? null
            : null,
        reusable_thread_id: reusableThreadId,
        predecessor_last_message: predecessorLastMessage,
        position: position + 1,
        total: orderedLeaves.length,
      },
    };
  }

  private async findDirtyPullRequestForIssue(config: WorkflowConfig, issue: Issue): Promise<PullRequestRef | null> {
    if (!issue.number) return null;
    const client = new GithubIssueTrackerClient(config.tracker);
    const prs = await client.listOpenPullRequests().catch(() => []);
    for (const pr of prs) {
      if (!this.isSymphonyPullRequest(config, pr)) continue;
      if (issueNumberFromPullRequestBody(pr.body) !== issue.number) continue;
      const detailed = await client.fetchPullRequest(pr.number).catch(() => pr);
      if (detailed && isDirtyMergeState(detailed.merge_state_status)) return detailed;
    }
    return null;
  }

  private async findPullRequestForIssue(config: WorkflowConfig, issue: Issue): Promise<PullRequestRef | null> {
    if (!issue.number) return null;
    const client = new GithubIssueTrackerClient(config.tracker);
    const prs = await client.listOpenPullRequests().catch(() => []);
    for (const pr of prs) {
      if (!this.isSymphonyPullRequest(config, pr)) continue;
      if (issueNumberFromPullRequestBody(pr.body) !== issue.number) continue;
      return await client.fetchPullRequest(pr.number).catch(() => pr);
    }
    return null;
  }

  private async applyLabels(config: WorkflowConfig, issueNumber: number, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    const client = new GithubIssueTrackerClient(config.tracker);
    await client.transitionLabels(issueNumber, opts);
  }

  private async updateLifecycleState(
    workspacePath: string,
    opts: { add?: string[]; remove?: string[]; workflowState?: string | null },
  ): Promise<void> {
    await updateRunState(workspacePath, (cur) => {
      if (!cur) return null;
      const labels = new Set(cur.labels ?? []);
      for (const label of opts.remove ?? []) labels.delete(label);
      for (const label of opts.add ?? []) labels.add(label);
      return {
        ...cur,
        labels: [...labels].sort(),
        workflow_state: opts.workflowState ?? cur.workflow_state ?? null,
        updated_at: new Date().toISOString(),
      };
    });
  }

  private async upsertStatus(config: WorkflowConfig, issue: Issue, state: RunState, message: string): Promise<void> {
    if (!issue.number) return;
    const client = new GithubIssueTrackerClient(config.tracker);
    const body = formatStatusComment({
      issue,
      config,
      repoId: this.repoId,
      state,
      message,
    });
    const result = await client.upsertStatusComment(issue.number, statusMarker(issue), body, state.status_comment_id ?? null);
    await updateRunState(state.workspace_path, (cur) =>
      cur
        ? {
            ...cur,
            status_comment_id: result.id,
            updated_at: new Date().toISOString(),
          }
        : null,
    );
  }

  private async pauseForInteractive(config: WorkflowConfig, issue: Issue, workspacePath: string, message: string): Promise<void> {
    if (!issue.number) return;
    const now = new Date().toISOString();
    await this.applyLabels(config, issue.number, { remove: [LABEL_READY, LABEL_RUNNING] });
    await updateRunState(workspacePath, (cur) =>
      cur
        ? {
            ...cur,
            status: 'paused',
            pause_reason: 'interactive',
            finished_at: now,
            last_handoff_at: now,
            labels: issue.labels.filter((label) => label !== LABEL_READY && label !== LABEL_RUNNING),
            workflow_state: 'interactive',
            updated_at: now,
          }
        : null,
    );
    await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), message);
  }

  private async postPlanningResult(config: WorkflowConfig, issue: Issue, workspacePath: string, lastMessagePath: string): Promise<void> {
    if (!issue.number) return;
    const lastMessage = (await this.readLastMessage(lastMessagePath)).trim();
    const body = [
      '## Symphony Technical Specification',
      '',
      lastMessage || `The planning agent completed successfully, but no final message was captured. Review the workspace artifacts in \`${workspacePath}\`.`,
    ].join('\n');
    await new GithubIssueTrackerClient(config.tracker).createIssueComment(issue.number, body);
  }

  private async readLastMessage(lastMessagePath: string): Promise<string> {
    try {
      return await fs.readFile(lastMessagePath, 'utf8');
    } catch {
      return '';
    }
  }

  private async mustReadRunState(workspacePath: string): Promise<RunState> {
    const state = await readRunState(workspacePath);
    if (!state) throw new SymphonyConfigError(`Missing Symphony run state in ${workspacePath}`);
    return state;
  }

  private async scheduleRetry(config: WorkflowConfig, issue: Issue, attempt: number, reason: string, workspacePath?: string): Promise<void> {
    const nextAttempt = attempt + 1;
    if (config.agent.max_attempts !== null && nextAttempt > config.agent.max_attempts) {
      this.retries.delete(issue.id);
      log('warn', 'retry_exhausted', {
        repo_id: this.repoId ?? undefined,
        tracker_kind: config.tracker.kind,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'retry_exhausted',
        issue_id: issue.id,
        issue_number: issue.number,
        attempt,
        max_attempts: config.agent.max_attempts,
        reason,
      });
      if (issue.number) {
        await this.applyLabels(config, issue.number, { add: [LABEL_NEEDS_INFO], remove: [LABEL_READY, LABEL_RUNNING] });
        if (workspacePath) {
          await this.updateLifecycleState(workspacePath, {
            add: [LABEL_NEEDS_INFO],
            remove: [LABEL_READY, LABEL_RUNNING],
            workflowState: LABEL_NEEDS_INFO,
          });
          await this.upsertStatus(
            config,
            issue,
            await this.mustReadRunState(workspacePath),
            `Autonomous run failed after ${config.agent.max_attempts} attempt(s). Review the workspace and latest error before re-queueing.`,
          );
        }
      }
      return;
    }
    const delayMs = computeBackoffMs(nextAttempt, config.agent.max_retry_backoff_ms);
    const nextAt = nowMs() + delayMs;

    this.retries.set(issue.id, {
      attempt: nextAttempt,
      next_run_at_ms: nextAt,
      issue_number: issue.number ?? -1,
      issue_id: issue.id,
    });

    log('info', 'retry_scheduled', {
      repo_id: this.repoId ?? undefined,
      tracker_kind: config.tracker.kind,
      owner: config.tracker.owner,
      repo: config.tracker.repo,
      event: 'retry_scheduled',
      issue_id: issue.id,
      issue_number: issue.number,
      delay_ms: delayMs,
      attempt: nextAttempt,
      reason,
    });
  }

  private async refreshProviderUsageLimitChecks(config: WorkflowConfig): Promise<void> {
    this.providerUsageLimitCheckBlocked.clear();
    const providersByGroup = new Map<string, AgentProviderConfig>();
    for (const provider of Object.values(config.agents.providers)) {
      if (!provider.usage_limit_check_command) continue;
      const limitKey = providerLimitKey(provider);
      if (!providersByGroup.has(limitKey)) providersByGroup.set(limitKey, provider);
    }
    const providers = [...providersByGroup.values()];
    await Promise.all(
      providers.map(async (provider) => {
        const command = provider.usage_limit_check_command!;
        const limitKey = providerLimitKey(provider);
        const result = await new Promise<UsageLimitCheckResult>((resolve) => {
          let settled = false;
          const finalize = (value: UsageLimitCheckResult) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };

          const child = spawn(command, {
            shell: true,
            stdio: 'ignore',
            env: process.env,
          });
          const timeout = setTimeout(() => {
            // Process may have already exited by the time kill() is called; that is harmless.
            try { child.kill('SIGTERM'); } catch { /* already exited */ }
            log('warn', 'provider_usage_limit_check_timeout', {
              repo_id: this.repoId ?? undefined,
              event: 'provider_usage_limit_check_timeout',
              agent_provider: provider.id,
              agent_provider_group: limitKey,
              check_command: command,
            });
            finalize('unknown');
          }, 30_000);
          timeout.unref();
          child.on('error', (err) => {
            clearTimeout(timeout);
            log('warn', 'provider_usage_limit_check_error', {
              repo_id: this.repoId ?? undefined,
              event: 'provider_usage_limit_check_error',
              agent_provider: provider.id,
              agent_provider_group: limitKey,
              check_command: command,
              error: err.message,
            });
            finalize('unknown');
          });
          child.on('exit', (code) => {
            clearTimeout(timeout);
            if (code === 0) finalize('allowed');
            else if (code === 2) finalize('unknown');
            else finalize('blocked');
          });
        });
        if (result === 'unknown') {
          log('warn', 'provider_usage_limit_check_unknown', {
            repo_id: this.repoId ?? undefined,
            event: 'provider_usage_limit_check_unknown',
            agent_provider: provider.id,
            agent_provider_group: limitKey,
            check_command: command,
          });
        }
        if (result === 'blocked') {
          this.providerUsageLimitCheckBlocked.add(limitKey);
          log('warn', 'provider_usage_limit_check_blocked', {
            repo_id: this.repoId ?? undefined,
            event: 'provider_usage_limit_check_blocked',
            agent_provider: provider.id,
            agent_provider_group: limitKey,
            check_command: command,
          });
        }
      }),
    );
  }

  private dispatchBlockReason(
    config: WorkflowConfig,
    issue: Issue,
    provider: AgentProviderConfig,
    capacity: DispatchCapacity,
  ): DispatchBlockReason | null {
    if (capacity.remaining !== null && capacity.remaining <= 0) return 'global_capacity';
    const maxConcurrentAgents = this.maxConcurrentAgentsOverride ?? config.agent.max_concurrent_agents;
    if (this.getRunningCount() >= maxConcurrentAgents) return 'global_capacity';
    const byState = config.agent.max_concurrent_agents_by_state;
    if (byState) {
      const limit = byState[issue.state];
      if (typeof limit === 'number') {
        const runningInState = [...this.running.values()].filter((s) => s.issue_state === issue.state).length;
        const orphanedInState = [...this.liveOrphanClaims.values()].filter((s) => s.issue_state === issue.state).length;
        if (runningInState + orphanedInState >= limit) return 'state_capacity';
      }
    }
    const limitKey = providerLimitKey(provider);
    const backoffUntil = this.providerUsageLimitBackoffUntil.get(limitKey);
    if (backoffUntil !== undefined && nowMs() < backoffUntil) return 'usage_limit';
    if (this.providerUsageLimitCheckBlocked.has(limitKey)) return 'usage_limit';
    if (provider.max_concurrent !== null) {
      const runningForProvider = [...this.running.values()].filter((s) => s.agent_provider_group === limitKey).length;
      const orphanedForProvider = [...this.liveOrphanClaims.values()].filter((s) => s.agent_provider_group === limitKey).length;
      if (runningForProvider + orphanedForProvider >= provider.max_concurrent) return 'provider_capacity';
    }
    return null;
  }
}
