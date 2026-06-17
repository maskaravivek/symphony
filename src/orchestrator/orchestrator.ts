import type { Issue } from '../domain/issue.js';
import { GithubIssueTrackerClient } from '../github/githubClient.js';
import { runAgent, assertAgentEligibleCommand } from '../runner/agentRunner.js';
import { extractCodexThreadId } from '../runner/codexEvents.js';
import { renderPrompt, renderTemplate } from '../templating/renderPrompt.js';
import { SymphonyConfigError } from '../utils/errors.js';
import { log, type LogFields } from '../utils/log.js';
import { sleep } from '../utils/sleep.js';
import { runHookScript } from '../workspace/hooks.js';
import { WorkspaceManager } from '../workspace/workspaceManager.js';
import { loadWorkflowFromFile } from '../workflow/loadWorkflow.js';
import type { LoadedWorkflow, WorkflowConfig } from '../workflow/types.js';
import { readRunState, updateRunState, writeRunState, type CodexMode, type PauseReason, type RunState } from '../status/runState.js';
import { buildRunContext } from './runContext.js';
import { formatPauseComment, parsePauseRequest } from './pauseProtocol.js';
import { formatStatusComment, statusMarker } from './statusComment.js';
import path from 'node:path';
import fs from 'node:fs/promises';

interface DispatchCapacity {
  remaining: number | null;
}

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

interface RunningSession {
  issue_id: string;
  issue_number: number;
  issue_identifier: string;
  issue_url: string | null;
  issue_state: string;
  workspace_path: string;
  session_id: string;
  started_at_ms: number;
  cancelled_reason: string | null;
  cancel: (reason: string) => Promise<void>;
}

const LABEL_READY = 'ready-for-agent';
const LABEL_RUNNING = 'agent-running';
const LABEL_INTERACTIVE = 'interactive';
const LABEL_NEEDS_INFO = 'needs-info';
const LABEL_READY_FOR_HUMAN = 'ready-for-human';

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

function computeBackoffMs(attempt: number, maxBackoffMs: number): number {
  const delay = 10_000 * Math.pow(2, attempt - 1);
  return Math.min(delay, maxBackoffMs);
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

export class Orchestrator {
  private workflowPath: string;
  private repoId: string | null;
  private maxConcurrentAgentsOverride: number | null;
  private lastGoodWorkflow: LoadedWorkflow | null = null;

  private running = new Map<string, RunningSession>();
  private retries = new Map<string, RetryEntry>();

  private stopped = false;

  constructor(options: OrchestratorOptions) {
    this.workflowPath = options.workflowPath;
    this.repoId = options.repoId ?? null;
    this.maxConcurrentAgentsOverride = options.maxConcurrentAgents ?? null;
  }

  getRunningCount(): number {
    return this.running.size;
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
        await s.cancel(reason);
      }),
    );
    this.running.clear();
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

    const trackerClient = new GithubIssueTrackerClient(config.tracker);
    const workspaceManager = new WorkspaceManager(config.workspace);

    await this.reconcileRunning(config, trackerClient, workspaceManager);

    let candidates: Issue[];
    try {
      candidates = await trackerClient.fetchCandidateIssues();
    } catch (err) {
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

    const eligibleCandidates = candidates.filter((issue) => !this.running.has(issue.id));
    const capacity: DispatchCapacity = { remaining: options.maxNewDispatches ?? null };

    await this.dispatchReadyRetries(config, eligibleCandidates, workspaceManager, capacity);
    await this.dispatchNewIssues(config, eligibleCandidates, workspaceManager, capacity);
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
    if (!config.codex.command) throw new SymphonyConfigError('codex.command is required');
    if (!config.codex.resume_command) throw new SymphonyConfigError('codex.resume_command is required');
    if (!config.codex.handoff_command) throw new SymphonyConfigError('codex.handoff_command is required');
    if (!config.workspace.root) throw new SymphonyConfigError('workspace.root is required');
    assertAgentEligibleCommand(config.codex.command);
    assertAgentEligibleCommand(config.codex.resume_command);
    assertAgentEligibleCommand(config.codex.handoff_command);
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

  private async dispatchReadyRetries(
    config: WorkflowConfig,
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

      if (!this.canDispatch(config, candidate, capacity)) return;
      try {
        await this.dispatchIssue(config, candidate, workspaceManager, { attempt: entry.attempt });
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
    candidates: Issue[],
    workspaceManager: WorkspaceManager,
    capacity: DispatchCapacity,
  ): Promise<void> {
    for (const issue of candidates) {
      if (!this.canDispatch(config, issue, capacity)) return;
      if (this.retries.has(issue.id)) continue;
      try {
        await this.dispatchIssue(config, issue, workspaceManager, { attempt: 1 });
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

  private async dispatchIssue(
    config: WorkflowConfig,
    issue: Issue,
    workspaceManager: WorkspaceManager,
    opts: { attempt: number },
  ): Promise<void> {
    if (!issue.number) throw new SymphonyConfigError('issue.number is required to dispatch work');
    const issueFields = getIssueLogFields(config, issue, this.repoId);

    log('info', 'issue_claimed', { ...issueFields, event: 'issue_claimed', status: 'claimed' });

    const { workspace_path: workspacePath, is_new: isNew } = await workspaceManager.ensureWorkspace(issue);
    const workspaceFields = { ...issueFields, workspace_path: workspacePath };

    const hasGitRepo = await workspaceManager.hasGitRepo(workspacePath);
    const shouldRunAfterCreate = Boolean(config.hooks.after_create) && (isNew || !hasGitRepo);

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
      const rendered = await renderTemplate(config.hooks.after_create, { issue });
      await runHookScript(rendered, workspacePath, config.hooks.timeout_ms);
      log('info', 'workspace_after_create_hook_completed', { ...workspaceFields, event: 'workspace_after_create_hook_completed' });
    }

    const existingState = await readRunState(workspacePath);
    const isPausedResume = existingState?.status === 'paused';

    if (config.hooks.before_run && !isPausedResume) {
      log('info', 'workspace_before_run_hook_started', { ...workspaceFields, event: 'workspace_before_run_hook_started' });
      const rendered = await renderTemplate(config.hooks.before_run, { issue });
      await runHookScript(rendered, workspacePath, config.hooks.timeout_ms);
      log('info', 'workspace_before_run_hook_completed', { ...workspaceFields, event: 'workspace_before_run_hook_completed' });
    } else if (config.hooks.before_run && isPausedResume) {
      log('info', 'workspace_before_run_hook_skipped', {
        ...workspaceFields,
        event: 'workspace_before_run_hook_skipped',
        reason: 'paused_resume_preserves_workspace',
      });
    }

    const comments = await new GithubIssueTrackerClient(config.tracker).listIssueComments(issue.number);
    const lastMessagePath = path.join(workspacePath, '.symphony', 'last_message.md');
    const runContext = await buildRunContext({
      workspacePath,
      comments,
      lastSeenCommentId: existingState?.last_seen_comment_id ?? null,
      lastMessagePath: existingState?.last_message_path ?? lastMessagePath,
    });

    const isInteractiveHandoff = issue.labels.includes(LABEL_INTERACTIVE);
    const handoffInstructions = isInteractiveHandoff
      ? '\n\n---\n\n## Interactive Handoff Instructions\n\nCreate a concise orientation summary for the user to continue this issue interactively. Do not edit files, run write commands, commit, push, or open a PR in this handoff pass.\n'
      : '';
    const prompt = `${await renderPrompt(this.lastGoodWorkflow?.prompt_template ?? '', issue)}${runContext.text}${handoffInstructions}`;
    const promptPath = await workspaceManager.writePrompt(workspacePath, prompt);
    const codexJsonlPath = path.join(workspacePath, '.symphony', 'codex.jsonl');

    let codexThreadId = existingState?.codex_thread_id ?? null;
    const codexMode: CodexMode = isInteractiveHandoff ? 'interactive-handoff' : 'autonomous';
    const pauseReason: PauseReason = isInteractiveHandoff ? 'interactive' : null;
    const commandTemplate = isInteractiveHandoff
      ? config.codex.handoff_command
      : codexThreadId
        ? config.codex.resume_command
        : config.codex.command;
    const renderedCommand = await renderTemplate(commandTemplate, {
      issue,
      symphony: { prompt_path: promptPath, workspace_path: workspacePath, codex_thread_id: codexThreadId ?? '' },
    });

    const env: Record<string, string> = {
      SYMPHONY_REPO_ID: this.repoId ?? '',
      SYMPHONY_TRACKER_OWNER: config.tracker.owner,
      SYMPHONY_TRACKER_REPO: config.tracker.repo,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_NUMBER: String(issue.number ?? ''),
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHONY_ISSUE_URL: issue.url ?? '',
      SYMPHONY_WORKSPACE_PATH: workspacePath,
      SYMPHONY_PROMPT_PATH: promptPath,
      SYMPHONY_BRANCH_NAME: issue.branch_name ?? '',
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
      attempt: opts.attempt,
      session_id: null,
      codex_thread_id: codexThreadId,
      codex_mode: codexMode,
      pause_reason: pauseReason,
      worker_pid: null,
      status: 'running',
      started_at: new Date().toISOString(),
      finished_at: null,
      last_exit_code: null,
      last_signal: null,
      last_error: null,
      prompt_path: promptPath,
      codex_jsonl_path: codexJsonlPath,
      last_message_path: lastMessagePath,
      last_seen_comment_id: runContext.lastSeenCommentId,
      status_comment_id: statusCommentId,
      last_handoff_at: isInteractiveHandoff ? new Date().toISOString() : existingState?.last_handoff_at ?? null,
      updated_at: new Date().toISOString(),
    };

    await writeRunState(workspacePath, initialState);

    try {
      if (isInteractiveHandoff) {
        await this.applyLabels(config, issue.number, { remove: [LABEL_READY, LABEL_RUNNING] });
        await this.updateLifecycleState(workspacePath, { remove: [LABEL_READY, LABEL_RUNNING], workflowState: 'interactive' });
        await this.upsertStatus(config, issue, initialState, 'Interactive handoff requested. Preparing a Codex thread and pausing autonomous work.');
      } else {
        await this.applyLabels(config, issue.number, { add: [LABEL_RUNNING], remove: [LABEL_READY, LABEL_NEEDS_INFO] });
        await this.updateLifecycleState(workspacePath, { add: [LABEL_RUNNING], remove: [LABEL_READY, LABEL_NEEDS_INFO], workflowState: LABEL_RUNNING });
        await this.upsertStatus(config, issue, initialState, 'Claimed by Symphony. Autonomous Codex run is starting.');
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
      turnTimeoutMs: config.codex.turn_timeout_ms,
      logFields: { ...workspaceFields, event: 'worker_started', status: 'running', attempt: opts.attempt },
      onStdoutLine: (line) => {
        const threadId = extractCodexThreadId(line);
        if (!threadId || threadId === codexThreadId) return;
        codexThreadId = threadId;
        void updateRunState(workspacePath, (cur) => {
          if (!cur) return null;
          return { ...cur, codex_thread_id: threadId, updated_at: new Date().toISOString() };
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
      issue_state: issue.state,
      workspace_path: workspacePath,
      session_id: agent.session_id,
      started_at_ms: nowMs(),
      cancelled_reason: null,
      cancel: agent.cancel,
    };

    this.running.set(issue.id, session);

    void agent.exit
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
          return;
        }

        if (config.hooks.after_run) {
          log('info', 'workspace_after_run_hook_started', { ...endFields, event: 'workspace_after_run_hook_started' });
          try {
            const rendered = await renderTemplate(config.hooks.after_run, { issue });
            await runHookScript(rendered, workspacePath, config.hooks.timeout_ms);
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

          await this.applyLabels(config, issue.number!, { add: [LABEL_READY_FOR_HUMAN], remove: [LABEL_READY, LABEL_RUNNING] });
          await this.updateLifecycleState(workspacePath, {
            add: [LABEL_READY_FOR_HUMAN],
            remove: [LABEL_READY, LABEL_RUNNING],
            workflowState: LABEL_READY_FOR_HUMAN,
          });
          await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), 'Autonomous run completed. Issue is ready for human review.');
          return;
        }

        log('error', 'worker_failed', { ...endFields, event: 'worker_failed', status: 'failed', code });
        await this.applyLabels(config, issue.number!, { add: [LABEL_READY], remove: [LABEL_RUNNING] });
        await this.updateLifecycleState(workspacePath, { add: [LABEL_READY], remove: [LABEL_RUNNING], workflowState: LABEL_READY });
        await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), `Autonomous run failed with exit code ${code}. Symphony will retry.`);
        await this.scheduleRetry(config, issue, opts.attempt, 'nonzero_exit', workspacePath);
      })
      .catch((err) => {
        const endFields = { ...workspaceFields, session_id: agent.session_id };
        this.running.delete(issue.id);
        void updateRunState(workspacePath, (cur) => {
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
          void this.applyLabels(config, issue.number, { add: [LABEL_READY], remove: [LABEL_RUNNING] })
            .then(() => this.updateLifecycleState(workspacePath, { add: [LABEL_READY], remove: [LABEL_RUNNING], workflowState: LABEL_READY }))
            .catch(() => {});
        }
        void this.scheduleRetry(config, issue, opts.attempt, 'runner_error', workspacePath);
      });
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

  private canDispatch(config: WorkflowConfig, issue: Issue, capacity: DispatchCapacity): boolean {
    if (capacity.remaining !== null && capacity.remaining <= 0) return false;
    const maxConcurrentAgents = this.maxConcurrentAgentsOverride ?? config.agent.max_concurrent_agents;
    if (this.running.size >= maxConcurrentAgents) return false;
    const byState = config.agent.max_concurrent_agents_by_state;
    if (!byState) return true;
    const limit = byState[issue.state];
    if (typeof limit !== 'number') return true;
    const runningInState = [...this.running.values()].filter((s) => s.issue_state === issue.state).length;
    return runningInState < limit;
  }
}
