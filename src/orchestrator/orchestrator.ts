import { GROOMING_LABEL, groomingSource, groomingInstructions, parseGroomingResult, groomingBrief } from '../grooming/grooming.js';
import { routedProviderId } from '../agents/routing.js';
import { maintainStorage, storageAvailable } from '../storage/maintenance.js';
import { DispatchDeferredError, storagePolicy } from '../storage/policy.js';
import type { Issue } from '../domain/issue.js';
import { leafEpicNodes, type EpicTreeNode } from '../domain/epic.js';
import {
  GithubIssueTrackerClient,
  isGithubRateLimitError,
  type IssueComment,
  type IssueReaction,
  type PullRequestRef,
} from '../github/githubClient.js';
import { EpisodeStore } from '../episodes/episodeStore.js';
import { assessAndMaybeMerge, type AutonomousMergeResult } from '../merge/autonomousMerge.js';
import { requiredPassingReviews, type VerificationReceipt } from '../merge/mergePolicy.js';
import { validateLocalPullRequest } from '../merge/localValidation.js';
import { resolvePromotedBase } from '../merge/stackPromotion.js';
import { dueScheduledLoops } from '../loops/scheduledLoops.js';
import { parseStructuredReviewResult, reviewNeedsHuman, type StructuredReviewResult } from '../review/reviewResult.js';
import { runAgent, assertAgentEligibleCommand } from '../runner/agentRunner.js';
import { extractCodexThreadId } from '../runner/codexEvents.js';
import { renderPrompt, renderTemplate } from '../templating/renderPrompt.js';
import { SymphonyConfigError } from '../utils/errors.js';
import { log, type LogFields } from '../utils/log.js';
import { recoverFreshRunGitState } from '../workspace/gitRecovery.js';
import { HookScriptError, runHookScript } from '../workspace/hooks.js';
import { WorkspaceManager, workspacePathForIssue } from '../workspace/workspaceManager.js';
import { loadWorkflowFromFile } from '../workflow/loadWorkflow.js';
import type { AgentProviderConfig, LoadedWorkflow, ScheduledLoopConfig, WorkflowConfig, WorkspaceStrategy } from '../workflow/types.js';
import { readRunState, updateRunState, writeRunState, type AgentMode, type PauseReason, type RunState } from '../status/runState.js';
import { scanRunStates } from '../status/scanRunStates.js';
import { readEpicStates, reconcileEpicStateWithIssue, upsertEpicState, type EpicChildState, type EpicState } from '../status/epicState.js';
import { buildRunContext } from './runContext.js';
import { formatPauseComment, parsePauseRequest } from './pauseProtocol.js';
import { formatStatusComment, statusMarker } from './statusComment.js';
import { epicStatusMarker, formatEpicStatusComment } from './epicStatusComment.js';
import { acquireWorkflowLock, type WorkflowLock } from './workflowLock.js';
import { hasNonQueueableLifecycleLabel } from './lifecycle.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pruneSessionArtifacts, sessionArtifactDirectory } from '../artifacts/sessionArtifacts.js';

interface DispatchCapacity {
  remaining: number | null;
}

type DispatchBlockReason = 'global_capacity' | 'state_capacity' | 'provider_capacity' | 'usage_limit';
type UsageLimitCheckDecision = 'allowed' | 'blocked' | 'unknown';
type UsageLimitCheckResult = {
  decision: UsageLimitCheckDecision;
  resetsAtMs?: number;
};
type CodexBarUsageParseResult = {
  decision: UsageLimitCheckDecision;
  resetsAtMs?: number;
};
type UsageLimitCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const CODEXBAR_USAGE_LIMIT_THRESHOLD = 90;

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
  issue_identifier: string;
  reason: string;
  workspace_path: string | null;
  mode: AgentMode;
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

interface RunningLoop {
  agent_provider_group: string;
  cancel: (reason: string) => Promise<void>;
  done: Promise<void>;
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

type PullRequestReviewVerdict = 'pass' | 'block' | 'error' | 'unavailable';

interface PullRequestReviewState {
  version: 1;
  pr_number: number;
  issue_number: number | null;
  head_ref: string;
  head_sha: string | null;
  base_ref: string;
  base_sha: string | null;
  verdict: PullRequestReviewVerdict;
  auto_fix_iterations: number;
  reviewed_at: string;
  reason: string;
  receipts: VerificationReceipt[];
  last_review_comment_id?: number | null;
}

interface PullRequestFeedbackState {
  version: 1;
  pr_number: number;
  last_issue_comment_id: number | null;
  last_review_comment_id: number | null;
  pending: boolean;
  feedback_round: number;
  blocking_feedback_round: number;
  observed_head_sha: string | null;
  priorities: string[];
  has_blocking_feedback: boolean;
  exhausted: boolean;
  last_codex_approval_reaction_id: number | null;
  updated_at: string;
}

type EpicExecutionMode = WorkflowConfig['tracker']['epics']['execution_mode'];

const LABEL_READY = 'ready-for-agent';
const LABEL_RUNNING = 'agent-running';
const LABEL_INTERACTIVE = 'interactive';
const LABEL_NEEDS_INFO = 'needs-info';
const LABEL_FAILED = 'symphony-failed';
const LABEL_READY_FOR_HUMAN = 'ready-for-human';
const LABEL_PLANNING = 'planning';
const LABEL_TASK_SPEC = 'task:spec';
const LABEL_EPIC_STACKED = 'epic:stacked';
const LABEL_EPIC_INDEPENDENT = 'epic:independent';
const LABEL_REVIEW_PASSED = 'symphony-review:passed';
const LABEL_REVIEW_BLOCKING = 'symphony-review:blocking';
const LABEL_REVIEW_AUTO_FIX_PREFIX = 'symphony-review:auto-fix-';
const REVIEW_STATE_MARKER = '<!-- symphony-review-state:v1 -->';
const PR_FEEDBACK_STATE_MARKER = '<!-- symphony-pr-feedback-state:v1 -->';

function nowMs(): number {
  return Date.now();
}

function humanizeDurationMs(durationMs: number): string {
  const roundedMs = Math.max(0, Math.round(durationMs));
  const secondsTotal = Math.floor(roundedMs / 1000);
  const days = Math.floor(secondsTotal / 86400);
  const hours = Math.floor((secondsTotal % 86400) / 3600);
  const minutes = Math.floor((secondsTotal % 3600) / 60);
  const seconds = secondsTotal % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
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

function isReviewAutoFixLabel(label: string): boolean {
  return label.startsWith(LABEL_REVIEW_AUTO_FIX_PREFIX);
}

function reviewAutoFixIteration(labels: string[]): number {
  let max = 0;
  for (const label of labels) {
    if (!isReviewAutoFixLabel(label)) continue;
    const value = Number(label.slice(LABEL_REVIEW_AUTO_FIX_PREFIX.length));
    if (Number.isInteger(value) && value > max) max = value;
  }
  return max;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function reviewExecutionKey(config: WorkflowConfig, pr: PullRequestRef, lens: string): string {
  return fingerprint({
    pr: pr.number,
    head: pr.head_sha,
    base: pr.base_sha,
    policy: config.merge.policy_version ?? 'v1',
    workflow: config.workflow_sha ?? null,
    lens,
  });
}

function nextReviewLens(config: WorkflowConfig, pr: PullRequestRef, state: PullRequestReviewState | null): string {
  const completed = new Set(
    (state?.receipts ?? [])
      .filter((receipt) => receipt.head_sha === pr.head_sha && receipt.base_sha === pr.base_sha && (receipt.verdict === 'pass' || receipt.verdict === 'block'))
      .map((receipt) => receipt.reviewer?.lens)
      .filter((lens): lens is string => Boolean(lens)),
  );
  return config.review.lenses.find((lens) => !completed.has(lens)) ?? config.review.lenses[0] ?? 'staff-engineer';
}

function hookOutputFromError(err: unknown): string {
  if (err instanceof HookScriptError) return err.output;
  return '';
}

function dispatchErrorDetails(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof HookScriptError)) return message;
  const output = (err.stderr.trim() || err.stdout.trim()).slice(-2_000);
  return [message, output].filter(Boolean).join(': ');
}

function parsePullRequestReviewStateComment(body: string): PullRequestReviewState | null {
  if (!body.includes(REVIEW_STATE_MARKER)) return null;
  const match = /```json\s*([\s\S]*?)```/i.exec(body);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Partial<PullRequestReviewState>;
    if (parsed.version !== 1) return null;
    if (typeof parsed.pr_number !== 'number') return null;
    if (parsed.verdict !== 'pass' && parsed.verdict !== 'block' && parsed.verdict !== 'error' && parsed.verdict !== 'unavailable') return null;
    return {
      version: 1,
      pr_number: parsed.pr_number,
      issue_number: typeof parsed.issue_number === 'number' ? parsed.issue_number : null,
      head_ref: typeof parsed.head_ref === 'string' ? parsed.head_ref : '',
      head_sha: typeof parsed.head_sha === 'string' ? parsed.head_sha : null,
      base_ref: typeof parsed.base_ref === 'string' ? parsed.base_ref : 'main',
      base_sha: typeof parsed.base_sha === 'string' ? parsed.base_sha : null,
      verdict: parsed.verdict,
      auto_fix_iterations: Number.isInteger(parsed.auto_fix_iterations) && parsed.auto_fix_iterations! >= 0 ? parsed.auto_fix_iterations! : 0,
      reviewed_at: typeof parsed.reviewed_at === 'string' ? parsed.reviewed_at : '',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      last_review_comment_id: typeof parsed.last_review_comment_id === 'number' ? parsed.last_review_comment_id : null,
      receipts: Array.isArray(parsed.receipts)
        ? parsed.receipts.filter((receipt): receipt is VerificationReceipt => {
            if (!receipt || typeof receipt !== 'object') return false;
            const candidate = receipt as Partial<VerificationReceipt>;
            return (
              typeof candidate.receipt_id === 'string' &&
              typeof candidate.verifier === 'string' &&
              (candidate.verdict === 'pass' || candidate.verdict === 'block' || candidate.verdict === 'error' || candidate.verdict === 'unavailable') &&
              typeof candidate.head_sha === 'string' &&
              typeof candidate.base_sha === 'string' &&
              Array.isArray(candidate.evidence) &&
              candidate.evidence.every(
                (entry) =>
                  typeof entry === 'string' ||
                  (Boolean(entry) &&
                    typeof entry === 'object' &&
                    typeof entry.kind === 'string' &&
                    typeof entry.summary === 'string'),
              ) &&
              (candidate.reviewer === undefined ||
                candidate.reviewer === null ||
                (typeof candidate.reviewer.execution_id === 'string' &&
                  (candidate.reviewer.provider === null || typeof candidate.reviewer.provider === 'string') &&
                  (candidate.reviewer.model === null || typeof candidate.reviewer.model === 'string') &&
                  (candidate.reviewer.lens === null || typeof candidate.reviewer.lens === 'string'))) &&
              typeof candidate.verified_at === 'string'
            );
          })
        : [],
    };
  } catch {
    return null;
  }
}

function formatPullRequestReviewStateComment(state: PullRequestReviewState): string {
  return `${REVIEW_STATE_MARKER}
### Symphony PR Review State

This comment is managed by Symphony. It records the PR head SHA that was reviewed so Symphony can avoid duplicate reviews without relying on mutable labels.

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`
`;
}

function parsePullRequestFeedbackStateComment(body: string): PullRequestFeedbackState | null {
  if (!body.includes(PR_FEEDBACK_STATE_MARKER)) return null;
  const match = /```json\s*([\s\S]*?)```/i.exec(body);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Partial<PullRequestFeedbackState>;
    if (parsed.version !== 1 || typeof parsed.pr_number !== 'number' || typeof parsed.pending !== 'boolean') return null;
    return {
      version: 1,
      pr_number: parsed.pr_number,
      last_issue_comment_id: typeof parsed.last_issue_comment_id === 'number' ? parsed.last_issue_comment_id : null,
      last_review_comment_id: typeof parsed.last_review_comment_id === 'number' ? parsed.last_review_comment_id : null,
      pending: parsed.pending,
      feedback_round: Number.isInteger(parsed.feedback_round) && parsed.feedback_round! >= 0 ? parsed.feedback_round! : 0,
      blocking_feedback_round:
        Number.isInteger(parsed.blocking_feedback_round) && parsed.blocking_feedback_round! >= 0
          ? parsed.blocking_feedback_round!
          : parsed.has_blocking_feedback
            ? Number.isInteger(parsed.feedback_round) && parsed.feedback_round! >= 0
              ? parsed.feedback_round!
              : 0
            : 0,
      observed_head_sha: typeof parsed.observed_head_sha === 'string' ? parsed.observed_head_sha : null,
      priorities: Array.isArray(parsed.priorities)
        ? parsed.priorities.filter((priority): priority is string => typeof priority === 'string' && /^p[0-3]$/.test(priority))
        : [],
      has_blocking_feedback: typeof parsed.has_blocking_feedback === 'boolean' ? parsed.has_blocking_feedback : true,
      exhausted: typeof parsed.exhausted === 'boolean' ? parsed.exhausted : false,
      last_codex_approval_reaction_id:
        typeof parsed.last_codex_approval_reaction_id === 'number' ? parsed.last_codex_approval_reaction_id : null,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : '',
    };
  } catch {
    return null;
  }
}

function formatPullRequestFeedbackStateComment(state: PullRequestFeedbackState): string {
  return `${PR_FEEDBACK_STATE_MARKER}
### Symphony PR Feedback State

This comment is managed by Symphony. It records external PR feedback cursors independently of Symphony's own reviewer.

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`
`;
}

function isExternalPullRequestConversationComment(comment: IssueComment): boolean {
  return !comment.body.includes('<!-- symphony-');
}

function isCodexApprovalReaction(reaction: IssueReaction): boolean {
  return reaction.content === '+1' && /^chatgpt-codex-connector(?:\[bot\])?$/i.test(reaction.author ?? '');
}

function isReactionFreshForHead(reaction: IssueReaction, headCommittedAt: string | null): boolean {
  if (!reaction.created_at || !headCommittedAt) return false;
  const reactionAt = Date.parse(reaction.created_at);
  const commitAt = Date.parse(headCommittedAt);
  return Number.isFinite(reactionAt) && Number.isFinite(commitAt) && reactionAt >= commitAt;
}

function feedbackPriority(body: string): string | null {
  const badge = /\bP([0-3])\s+Badge\b/i.exec(body);
  if (badge) return `p${badge[1]}`;
  const bracketed = /\[P([0-3])\]/i.exec(body);
  if (bracketed) return `p${bracketed[1]}`;
  const standalone = /(?:^|\s)P([0-3])(?:\s|:|-|$)/i.exec(body);
  return standalone ? `p${standalone[1]}` : null;
}

function classifyPullRequestFeedback(
  comments: IssueComment[],
  nonBlockingPriorities: string[],
): { priorities: string[]; has_blocking_feedback: boolean } {
  const priorities = [...new Set(comments.map((comment) => feedbackPriority(comment.body)).filter((value): value is string => value !== null))];
  return {
    priorities,
    has_blocking_feedback:
      comments.length === 0 ||
      comments.some((comment) => {
        const priority = feedbackPriority(comment.body);
        return priority === null || !nonBlockingPriorities.includes(priority);
      }),
  };
}

function pullRequestHeadMatchesState(pr: PullRequestRef, state: PullRequestReviewState | null): boolean {
  if (!state?.head_sha || !pr.head_sha) return false;
  if (state.base_ref !== pr.base_ref) return false;
  if ((state.base_sha || pr.base_sha) && state.base_sha !== pr.base_sha) return false;
  return state.head_sha === pr.head_sha;
}

function freshPassingReceiptCount(config: WorkflowConfig, pr: PullRequestRef, state: PullRequestReviewState | null): number {
  if (!pr.head_sha || !pr.base_sha) return 0;
  return new Set(
    (state?.receipts ?? [])
      .filter(
        (receipt) =>
          receipt.verdict === 'pass' &&
          receipt.head_sha === pr.head_sha &&
          receipt.base_sha === pr.base_sha &&
          (receipt.policy_version ?? 'v1') === (config.merge.policy_version ?? 'v1') &&
          (receipt.workflow_sha ?? null) === (config.workflow_sha ?? null) &&
          receipt.evidence.some((entry) => typeof entry === 'string' || entry.kind === 'review') &&
          (!config.merge.require_independent_reviews ||
            (Boolean(receipt.reviewer?.execution_id) &&
              (!receipt.author_execution_id || receipt.reviewer?.execution_id !== receipt.author_execution_id))),
      )
      .map((receipt) => config.merge.require_independent_reviews ? receipt.reviewer!.execution_id : receipt.receipt_id),
  ).size;
}

function upsertVerificationReceipt(receipts: VerificationReceipt[], receipt: VerificationReceipt): VerificationReceipt[] {
  const key = (candidate: VerificationReceipt) => fingerprint({
    head: candidate.head_sha,
    base: candidate.base_sha,
    policy: candidate.policy_version ?? 'v1',
    workflow: candidate.workflow_sha ?? null,
    lens: candidate.reviewer?.lens ?? candidate.verifier,
  });
  return [...receipts.filter((candidate) => key(candidate) !== key(receipt)), receipt].slice(-20);
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

function terminateOrphanedWorker(pid: number | null | undefined): void {
  if (!pid || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process may have already exited by the time recovery runs.
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
    issue_title: issue.title,
    issue_url: issue.url,
  };
}

function hookLogPath(workspacePath: string, hookName: string): string {
  const safeHookName = hookName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(
    path.dirname(workspacePath),
    '.symphony',
    'hooks',
    path.basename(workspacePath),
    `${timestamp}-${safeHookName || 'hook'}.log`,
  );
}

function shouldStreamHookOutput(): boolean {
  return process.env.SYMPHONY_STREAM_HOOK_OUTPUT === '1';
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

function hasOpenNativeDependency(config: WorkflowConfig, issue: Issue): boolean {
  return issue.blocked_by.some(
    (blocker) => !blocker.state || !config.tracker.terminal_states.includes(blocker.state.trim().toLowerCase()),
  );
}

function selectAgentProvider(config: WorkflowConfig, issue: Issue): AgentProviderConfig {
  const providerId = routedProviderId(config.agents, issue.labels);
  const provider = config.agents.providers[providerId];
  if (!provider) throw new SymphonyConfigError(`agent provider not found: ${providerId}`);
  return provider;
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

async function captureVerificationSnapshot(
  workspacePath: string,
  artifactDir: string,
  outcome: { code: number | null; signal: NodeJS.Signals | null },
): Promise<void> {
  const runGit = (args: string[]) => new Promise<string | null>((resolve) => {
    execFile('git', args, { cwd: workspacePath }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
  const [headSha, status] = await Promise.all([
    runGit(['rev-parse', 'HEAD']),
    runGit(['status', '--porcelain=v1']),
  ]);
  const source = path.join(workspacePath, '.symphony', 'verification.json');
  await fs.copyFile(source, path.join(artifactDir, 'verification.json')).catch(async () => {
    await fs.writeFile(path.join(artifactDir, 'verification.json'), `${JSON.stringify({
      version: 1,
      captured_at: new Date().toISOString(),
      head_sha: headSha,
      working_tree_status: status?.split('\n').filter(Boolean) ?? [],
      agent_exit_code: outcome.code,
      agent_signal: outcome.signal,
      evidence: [],
    }, null, 2)}\n`, { mode: 0o600 });
  });
}

export class Orchestrator {
  private workflowPath: string;
  private repoId: string | null;
  private maxConcurrentAgentsOverride: number | null;
  private lastGoodWorkflow: LoadedWorkflow | null = null;

  private storageBlocked = false;
  private running = new Map<string, RunningSession>();
  private runningLoops = new Map<string, RunningLoop>();
  private retries = new Map<string, RetryEntry>();
  private conflictQueue = new Map<number, ConflictEntry>();
  private lastConflictScanAtMs = 0;
  private lastStackPromotionScanAtMs = 0;
  private lastPullRequestFeedbackScanAtMs = 0;
  private providerUsageLimitBackoffUntil = new Map<string, number>();
  private providerUsageLimitCheckBlocked = new Set<string>();
  private githubRateLimitBackoffUntilMs = 0;
  private workflowLock: WorkflowLock | null = null;
  private liveOrphanClaims = new Map<string, LiveOrphanClaim>();
  private recoveringFinalizations = new Set<string>();

  private stopped = false;
  private shutdownController = new AbortController();
  private wakeRunLoop: (() => void) | null = null;

  constructor(options: OrchestratorOptions) {
    this.workflowPath = options.workflowPath;
    this.repoId = options.repoId ?? null;
    this.maxConcurrentAgentsOverride = options.maxConcurrentAgents ?? null;
  }

  private storePath(config: WorkflowConfig): string {
    return path.join(config.workspace.root, '.symphony', 'episodes.sqlite');
  }

  private durableRepoId(config: WorkflowConfig): string {
    return this.repoId ?? `${config.tracker.owner}/${config.tracker.repo}`;
  }

  private loadDurableRetries(config: WorkflowConfig): void {
    const store = new EpisodeStore(this.storePath(config));
    try {
      this.retries = new Map(
        store.listRetries(this.durableRepoId(config)).map((entry) => [entry.issue_id, {
          attempt: entry.attempt,
          next_run_at_ms: Date.parse(entry.next_run_at),
          issue_number: entry.issue_number,
          issue_id: entry.issue_id,
          issue_identifier: entry.issue_identifier,
          reason: entry.reason,
          workspace_path: entry.workspace_path,
          mode: entry.mode as AgentMode,
        }]),
      );
    } finally {
      store.close();
    }
  }

  private deleteDurableRetry(config: WorkflowConfig, issueId: string): void {
    this.retries.delete(issueId);
    const store = new EpisodeStore(this.storePath(config));
    try {
      store.deleteRetry(this.durableRepoId(config), issueId);
    } finally {
      store.close();
    }
  }

  private async reconcileDurableRetries(config: WorkflowConfig, tracker: GithubIssueTrackerClient): Promise<void> {
    for (const entry of [...this.retries.values()]) {
      let issue: Issue | null;
      try {
        issue = await tracker.fetchIssueByNumber(entry.issue_number);
      } catch (error) {
        log('warn', 'retry_reconcile_issue_fetch_failed', {
          repo_id: this.repoId ?? undefined,
          issue_id: entry.issue_id,
          issue_number: entry.issue_number,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (issue && config.tracker.active_states.includes(issue.state) && !hasNonQueueableLifecycleLabel(entry.mode === 'grooming' ? issue.labels.filter(l => l !== GROOMING_LABEL) : issue.labels) && !hasAnyLabel(issue.labels, config.tracker.ignored_labels)) continue;
      this.deleteDurableRetry(config, entry.issue_id);
      if (issue?.number) await this.applyLabels(config, issue.number, { remove: [LABEL_READY, LABEL_RUNNING] }).catch(() => {});
      log('info', 'retry_cancelled', {
        repo_id: this.repoId ?? undefined,
        issue_id: entry.issue_id,
        issue_number: entry.issue_number,
        reason: issue ? 'issue_not_queueable' : 'issue_missing',
      });
    }
  }

  getRunningCount(): number {
    return this.running.size + this.runningLoops.size + this.liveOrphanClaims.size + this.recoveringFinalizations.size;
  }

  getRepoId(): string | null {
    return this.repoId;
  }

  setMaxConcurrentAgentsOverride(value: number | null): void {
    this.maxConcurrentAgentsOverride = value;
  }

  stop(): void {
    this.stopped = true;
    this.wakeRunLoop?.();
  }

  async shutdown(reason = 'shutdown'): Promise<void> {
    this.stopped = true;
    if (!this.shutdownController.signal.aborted) this.shutdownController.abort(reason);
    this.wakeRunLoop?.();
    const sessions = [...this.running.values()];
    const loops = [...this.runningLoops.values()];
    await Promise.allSettled(
      sessions.map(async (s) => {
        s.cancelled_reason = reason;
        await s.cancel(reason);
        await s.done;
      }),
    );
    await Promise.allSettled(loops.map(async (loop) => {
      await loop.cancel(reason);
      await loop.done;
    }));
    await this.releaseWorkflowLock();
  }

  async runForever(): Promise<void> {
    while (!this.stopped) {
      await this.tickOnce().catch((err) => {
        log('error', 'tick_failed', { event: 'tick_failed', error: err instanceof Error ? err.message : String(err) });
      });
      const interval = this.lastGoodWorkflow?.config.polling.interval_ms ?? 30_000;
      await this.sleepUntilNextTick(interval);
    }
  }

  private async sleepUntilNextTick(intervalMs: number): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, intervalMs);
      const wake = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.wakeRunLoop = wake;
    }).finally(() => {
      this.wakeRunLoop = null;
    });
  }

  async tickOnce(options: { maxNewDispatches?: number | null } = {}): Promise<void> {
    const loaded = await this.loadWorkflowSafe();
    if (!loaded) return;
    const { config } = loaded;

    if (!(await this.ensureWorkflowLock(config))) return;

    // Maintenance is independent of GitHub availability and holds the workflow lock.
    await maintainStorage(config.workspace, this.getRunningCount() > 0);
    const hasStorage = await this.hasStorageCapacity(config);
    if (this.isGithubRateLimitBackoffActive(config)) return;

    const trackerClient = new GithubIssueTrackerClient(config.tracker);
    const workspaceManager = new WorkspaceManager(config.workspace, this.maxConcurrentAgentsOverride ?? config.agent.max_concurrent_agents);

    try {
      await this.reconcileRunning(config, trackerClient, workspaceManager);
      await this.recoverFinalizingRuns(config, trackerClient);
      await this.reconcileOrphanedClaims(config, trackerClient, workspaceManager);
      this.loadDurableRetries(config);
      await this.reconcileDurableRetries(config, trackerClient);
      await this.sweepTerminalWorkspaces(config, trackerClient, workspaceManager);
      await this.refreshProviderUsageLimitChecks(config);
      const capacity: DispatchCapacity = { remaining: hasStorage ? options.maxNewDispatches ?? null : 0 };
      await this.promoteStackedPullRequests(config, trackerClient);
      await this.scanOpenPullRequestsForConflicts(config, trackerClient);
      await this.reconcilePullRequestFeedback(config, trackerClient);
      await this.reconcileAutonomousMerges(config, trackerClient);
      await this.dispatchConflictResolutions(config, trackerClient, workspaceManager, capacity);
      await this.dispatchPullRequestReviews(config, trackerClient, workspaceManager, capacity);
      await this.dispatchScheduledLoops(config, capacity);

      let candidates: Issue[];
      let groomingCandidates: Issue[];
      try {
        candidates = await trackerClient.fetchCandidateIssues();
        groomingCandidates = await trackerClient.fetchGroomingIssues().catch(error => {
          if (isGithubRateLimitError(error)) throw error;
          log('warn', 'grooming_poll_failed', { repo_id: this.repoId ?? undefined, event: 'grooming_poll_failed' });
          return [];
        });
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

      log('info', candidates.length === 0 ? 'candidate_poll_empty' : 'candidate_poll_completed', {
        repo_id: this.repoId ?? undefined,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: candidates.length === 0 ? 'candidate_poll_empty' : 'candidate_poll_completed',
        candidate_count: candidates.length,
        active_count: this.getRunningCount(),
        retry_count: this.retries.size,
        capacity_remaining: capacity.remaining,
      });

      if (config.tracker.epics.enabled) await this.reconcileClosedEpicParents(config, trackerClient, candidates);
      const epicParentIds = config.tracker.epics.enabled ? await this.processEpicCandidates(config, trackerClient, candidates) : new Set<string>();
      const eligibleCandidates = candidates.filter((issue) => !this.running.has(issue.id) && !epicParentIds.has(issue.id));

      await this.dispatchReadyRetries(config, trackerClient, [...eligibleCandidates, ...groomingCandidates], workspaceManager, capacity);
      await this.dispatchGroomingIssues(config, groomingCandidates, workspaceManager, capacity);
      await this.dispatchNewIssues(config, trackerClient, eligibleCandidates, workspaceManager, capacity);
    } catch (err) {
      if (this.handleGithubRateLimit(config, err, 'github_rate_limited')) return;
      throw err;
    }
  }

  private async hasStorageCapacity(config: WorkflowConfig): Promise<boolean> {
    const minimum = storagePolicy(config.workspace.storage_maintenance).min_free_gib;
    const available = await storageAvailable(config.workspace.root, minimum);
    const statusPath = path.join(config.workspace.root, '.symphony', 'storage-status.json');
    const previous = await fs.readFile(statusPath, 'utf8').then(raw => JSON.parse(raw) as { blocked: boolean; minimum_free_gib: number }).catch(() => null);
    if (previous?.blocked !== !available || previous?.minimum_free_gib !== minimum) {
      const temporary = `${statusPath}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ blocked: !available, minimum_free_gib: minimum }), { mode: 0o600 });
      await fs.rename(temporary, statusPath);
    }
    if (available === this.storageBlocked) {
      log(available ? 'info' : 'warn', available ? 'storage_dispatch_resumed' : 'storage_dispatch_paused', {
        event: available ? 'storage_dispatch_resumed' : 'storage_dispatch_paused', repo_id: this.repoId ?? undefined,
        workspace_root: config.workspace.root, minimum_free_gib: minimum,
      });
    }
    this.storageBlocked = !available;
    return available;
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
      log('debug', 'workflow_lock_acquired', {
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
        if (issue.number) await this.applyLabels(config, issue.number, { remove: [LABEL_READY, LABEL_RUNNING] }).catch(() => {});
        await updateRunState(session.workspace_path, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: 'cancelled',
            issue_title: issue.title,
            issue_state: issue.state,
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
        await updateRunState(session.workspace_path, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: 'cancelled',
            issue_title: issue.title,
            issue_state: issue.state,
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
        await updateRunState(session.workspace_path, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: 'cancelled',
            issue_title: issue.title,
            issue_state: issue.state,
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
        await updateRunState(session.workspace_path, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: 'cancelled',
            issue_title: issue.title,
            issue_state: issue.state,
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
      if (issue.number && issue.labels.includes(LABEL_READY) && hasNonQueueableLifecycleLabel(issue.labels)) {
        await this.applyLabels(config, issue.number, { remove: [LABEL_READY] });
        continue;
      }
      if (!issue.labels.includes(LABEL_RUNNING)) continue;
      if (this.running.has(issue.id)) continue;
      if (this.recoveringFinalizations.has(issue.id)) continue;

      const existingState = await this.readRunStateForIssue(config, issue);
      const { workspace_path: fallbackWorkspacePath } = existingState
        ? { workspace_path: existingState.workspace_path }
        : await workspaceManager.ensureWorkspace(issue, { strategy: 'durable_issue_workspace' });
      const workspacePath = fallbackWorkspacePath;
      const state = existingState ?? (await readRunState(workspacePath));
      const agentWasRunning = state?.status === 'agent-running';
      const liveOrphan = agentWasRunning && isProcessAlive(state.worker_pid);
      if (agentWasRunning && isProcessAlive(state.worker_pid)) {
        terminateOrphanedWorker(state.worker_pid);
      }

      const ignored = hasAnyLabel(issue.labels, config.tracker.ignored_labels);
      const nextLabels = ignored ? { remove: [LABEL_RUNNING] } : { add: [LABEL_READY], remove: [LABEL_RUNNING] };
      const nextWorkflowState = ignored ? null : LABEL_READY;
      const reason = liveOrphan
        ? 'live_orphan_worker_terminated'
        : agentWasRunning
          ? 'worker_pid_not_alive'
          : 'agent_running_without_running_state';

      log('warn', 'orphaned_claim_recovered', {
        ...getIssueLogFields(config, issue, this.repoId),
        workspace_path: workspacePath,
        event: 'orphaned_claim_recovered',
        status: 'cancelled',
        reason,
        worker_pid: state?.worker_pid ?? undefined,
      });
      this.appendEpisodeEvent(config, `${issue.identifier}:recovery`, 'repair.orphan_recovered', {
        issue_number: issue.number,
        issue_identifier: issue.identifier,
        reason,
        worker_pid: state?.worker_pid ?? null,
        requeued: !ignored,
      });

      await this.applyLabels(config, issue.number!, nextLabels);
      await updateRunState(workspacePath, (cur) =>
        cur
          ? {
              ...cur,
              status: 'cancelled',
              issue_title: issue.title,
              issue_state: issue.state,
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

  private async recoverFinalizingRuns(config: WorkflowConfig, tracker: GithubIssueTrackerClient): Promise<void> {
    const states = await scanRunStates(config.workspace.root);
    for (const state of states.filter((candidate) => candidate.status === 'finalizing' && candidate.issue_number)) {
      if (this.running.has(state.issue_id) || this.recoveringFinalizations.has(state.issue_id)) continue;
      const issue = await tracker.fetchIssueByNumber(state.issue_number!).catch(() => null);
      if (!issue) continue;
      this.recoveringFinalizations.add(state.issue_id);
      try {
        const finalization = state.finalization_context;
        if (finalization?.mode === 'interactive-handoff') {
          await this.pauseForInteractive(config, issue, state.workspace_path, 'Interactive handoff is ready.');
          await updateRunState(state.workspace_path, (cur) => cur ? { ...cur, status: 'paused', workflow_outcome: 'paused', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() } : null);
          this.appendEpisodeEvent(config, `${issue.identifier}:attempt:${state.attempt}`, 'workflow.paused', { issue_number: issue.number, session_id: state.session_id, reason: 'interactive', recovered: true });
          continue;
        }
        const pauseRequest = parsePauseRequest(await this.readLastMessage(state.last_message_path ?? ''));
        if (pauseRequest) {
          const marker = `<!-- symphony-pause:${state.session_id ?? state.issue_id} -->`;
          await tracker.upsertStatusComment(issue.number!, marker, `${marker}\n${formatPauseComment(pauseRequest)}`);
          await this.applyLabels(config, issue.number!, { add: [LABEL_NEEDS_INFO], remove: [LABEL_READY, LABEL_RUNNING] });
          await this.updateLifecycleState(state.workspace_path, { add: [LABEL_NEEDS_INFO], remove: [LABEL_READY, LABEL_RUNNING], workflowState: LABEL_NEEDS_INFO });
          await updateRunState(state.workspace_path, (cur) => cur ? { ...cur, status: 'paused', pause_reason: 'needs-info', workflow_outcome: 'paused', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() } : null);
          this.appendEpisodeEvent(config, `${issue.identifier}:attempt:${state.attempt}`, 'workflow.paused', { issue_number: issue.number, session_id: state.session_id, recovered: true });
          continue;
        }

        if (finalization?.mode === 'grooming') {
          await this.finishGrooming(config, issue, state.workspace_path, state.last_message_path ?? '');
          continue;
        }
        if (finalization?.mode === 'planning') {
          await this.postPlanningResult(config, issue, state.workspace_path, state.last_message_path ?? '');
          await this.applyLabels(config, issue.number!, { add: [LABEL_READY_FOR_HUMAN], remove: [LABEL_READY, LABEL_RUNNING] });
          await this.updateLifecycleState(state.workspace_path, { add: [LABEL_READY_FOR_HUMAN], remove: [LABEL_READY, LABEL_RUNNING], workflowState: LABEL_READY_FOR_HUMAN });
          await this.completeWorkflowState(state.workspace_path);
          this.appendEpisodeEvent(config, `${issue.identifier}:attempt:${state.attempt}`, 'workflow.completed', { issue_number: issue.number, session_id: state.session_id, outcome: 'planning-posted', recovered: true });
          continue;
        }

        const savedReview = finalization?.review_pr;
        const reviewPr = savedReview
          ? await tracker.fetchPullRequest(savedReview.pr_number).catch(() => null)
          : await this.findReviewPullRequest(config, issue, undefined);
        if (savedReview && (!reviewPr || reviewPr.head_sha !== savedReview.head_sha || reviewPr.base_sha !== savedReview.base_sha)) {
          throw new Error(`PR #${savedReview.pr_number} changed while finalization was interrupted`);
        }
        let reviewResult: StructuredReviewResult | null = null;
        const completedHookOutput = state.finalization_step === 'hook-completed' && state.session_artifact_dir
          ? await fs.readFile(path.join(state.session_artifact_dir, 'code-review.md'), 'utf8').catch(() => '')
          : '';
        if (reviewPr && completedHookOutput) reviewResult = parseStructuredReviewResult(completedHookOutput);
        if (config.hooks.after_run && state.finalization_step !== 'hook-completed') {
          const reviewPrompt = reviewPr && config.review.enabled
            ? await this.writePullRequestReviewPrompt(config, state.workspace_path, issue, reviewPr, savedReview?.lens)
            : null;
          const context = {
            workspace_path: state.workspace_path,
            workspace_strategy: state.workspace_strategy ?? 'durable_issue_workspace',
            agent_provider: state.agent_provider ?? 'codex',
            agent_provider_group: state.agent_provider_group ?? '',
            agent_provider_kind: state.agent_provider_kind ?? '',
            review_prompt_path: reviewPrompt?.path ?? '',
            review_pr_number: reviewPr?.number ?? '',
            review_pr_url: reviewPr?.url ?? '',
            review_pr_head_ref: reviewPr?.head_ref ?? '',
            review_pr_head_sha: reviewPr?.head_sha ?? '',
            review_pr_base_ref: reviewPr?.base_ref ?? '',
            review_pr_base_sha: reviewPr?.base_sha ?? '',
            review_issue_number: savedReview?.originating_issue_number ?? issueNumberFromPullRequestBody(reviewPr?.body ?? null) ?? issue.number ?? '',
            review_execution_key: savedReview?.review_key ?? '',
          };
          const rendered = await renderTemplate(config.hooks.after_run, { issue, symphony: context });
          await updateRunState(state.workspace_path, (cur) => cur ? { ...cur, finalization_step: 'hook-running', updated_at: new Date().toISOString() } : null);
          let recoveredHookOutput: string;
          try {
            const result = await runHookScript(rendered, state.workspace_path, config.hooks.timeout_ms, {
              env: {
              SYMPHONY_REVIEW_ENABLED: config.review.enabled ? '1' : '0',
              SYMPHONY_REVIEW_PROMPT_PATH: reviewPrompt?.path ?? '',
              SYMPHONY_REVIEW_PR_NUMBER: String(reviewPr?.number ?? ''),
              SYMPHONY_REVIEW_PR_URL: reviewPr?.url ?? '',
              SYMPHONY_REVIEW_PR_HEAD_REF: reviewPr?.head_ref ?? '',
              SYMPHONY_REVIEW_PR_HEAD_SHA: reviewPr?.head_sha ?? '',
              SYMPHONY_REVIEW_PR_BASE_REF: reviewPr?.base_ref ?? '',
              SYMPHONY_REVIEW_PR_BASE_SHA: reviewPr?.base_sha ?? '',
              SYMPHONY_REVIEW_ISSUE_NUMBER: String(context.review_issue_number),
              SYMPHONY_REVIEW_LENS: savedReview?.lens ?? reviewPrompt?.lens ?? 'staff-engineer',
              SYMPHONY_REVIEW_EXECUTION_KEY: savedReview?.review_key ?? '',
              SYMPHONY_RUN_ARTIFACT_DIR: state.session_artifact_dir ?? path.join(state.workspace_path, '.symphony'),
              SYMPHONY_LAST_MESSAGE_PATH: state.last_message_path ?? '',
              },
              logPath: path.join(state.session_artifact_dir ?? path.join(state.workspace_path, '.symphony'), 'after_run-recovered.log'),
              signal: this.shutdownController.signal,
            });
            recoveredHookOutput = result.output;
          } catch (error) {
            const parsed = reviewPr ? parseStructuredReviewResult(hookOutputFromError(error)) : null;
            if (parsed?.verdict !== 'block') throw error;
            recoveredHookOutput = hookOutputFromError(error);
          }
          reviewResult = reviewPr ? parseStructuredReviewResult(recoveredHookOutput) : null;
          await updateRunState(state.workspace_path, (cur) => cur ? { ...cur, finalization_step: 'hook-completed', updated_at: new Date().toISOString() } : null);
        }
        if (reviewPr && config.review.enabled) {
          if (reviewResult?.verdict === 'block') await this.handleBlockingPullRequestReview(config, issue, reviewPr, state.workspace_path, reviewResult);
          if (reviewResult?.verdict === 'pass') await this.handlePassingPullRequestReview(config, issue, reviewPr, state.workspace_path, reviewResult);
          if (!reviewResult || reviewResult.verdict === 'retry') throw new Error('Recovered finalization did not produce a terminal review verdict');
        }
        if (reviewPr && config.merge.enabled && requiredPassingReviews(config.merge) === 0) {
          await this.recordLocalValidation(config, issue, reviewPr, state.workspace_path);
        }

        if (!reviewPr || !config.review.enabled) await this.applyLabels(config, issue.number!, { add: [LABEL_READY_FOR_HUMAN], remove: [LABEL_READY, LABEL_RUNNING] });
        await updateRunState(state.workspace_path, (cur) => cur ? { ...cur, status: 'completed', finalization_step: 'effects-applied', workflow_outcome: 'completed', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() } : null);
        this.appendEpisodeEvent(config, `${issue.identifier}:attempt:${state.attempt}`, 'workflow.completed', { issue_number: issue.number, session_id: state.session_id, recovered: true });
      } catch (err) {
        const error = dispatchErrorDetails(err);
        await this.scheduleRetry(config, issue, state.attempt, `finalization_recovery_failed: ${error}`, state.workspace_path);
        log('error', 'finalization_recovery_failed', { ...getIssueLogFields(config, issue, this.repoId), error });
      } finally {
        this.recoveringFinalizations.delete(state.issue_id);
      }
    }
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
      if (this.recoveringFinalizations.has(state.issue_id)) continue;
      if (state.status === 'agent-running' && isProcessAlive(state.worker_pid)) continue;
      if (state.status === 'finalizing' || state.status === 'retry-wait') continue;
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

      this.appendEpisodeEvent(config, `${issue.identifier}:outcome`, 'issue.closed', {
        issue_number: issue.number,
        issue_identifier: issue.identifier,
        issue_state: issue.state,
        run_status: state.status,
        workspace_path: state.workspace_path,
      });

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
      if (err instanceof DispatchDeferredError) return;
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
    if (requiredPassingReviews(config.merge) === 0 && !config.review.enabled && !config.review.shepherd_pull_requests) return;
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
      if (this.retries.has(issue.id)) continue;

      const pr = await tracker.fetchPullRequest(issue.number).catch(() => null);
      if (!pr || pr.is_draft || !pr.head_ref) continue;
      const feedbackState = await this.readPullRequestFeedbackState(config, pr.number).catch((err) => {
        log('warn', 'pr_feedback_state_read_failed', {
          ...getIssueLogFields(config, issue, this.repoId),
          event: 'pr_feedback_state_read_failed',
          pr_number: pr.number,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      const reviewState = await this.readPullRequestReviewState(config, pr.number).catch((err) => {
        log('warn', 'pr_review_state_read_failed', {
          ...getIssueLogFields(config, issue, this.repoId),
          event: 'pr_review_state_read_failed',
          pr_number: pr.number,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      if (!feedbackState?.pending && reviewState?.verdict === 'pass' && pullRequestHeadMatchesState(pr, reviewState)) {
        if (!config.merge.enabled || freshPassingReceiptCount(config, pr, reviewState) >= requiredPassingReviews(config.merge)) {
          log('info', 'pr_review_skipped_already_passed_for_head', {
            ...getIssueLogFields(config, issue, this.repoId),
            event: 'pr_review_skipped_already_passed_for_head',
            pr_number: pr.number,
            head_sha: pr.head_sha ?? '',
          });
          continue;
        }
      }

      const provider = selectAgentProvider(config, issue);
      if (this.dispatchBlockReason(config, issue, provider, capacity)) continue;
      const lens = nextReviewLens(config, pr, reviewState);
      const reviewKey = reviewExecutionKey(config, pr, lens);
      const store = new EpisodeStore(this.storePath(config));
      let claimed = false;
      try {
        claimed = store.claimReview(this.durableRepoId(config), reviewKey, 'running');
      } finally {
        store.close();
      }
      if (!claimed) {
        log('info', 'pr_review_skipped_duplicate_execution', {
          repo_id: this.repoId ?? undefined,
          pr_number: pr.number,
          head_sha: pr.head_sha ?? '',
          lens,
        });
        continue;
      }

      try {
        await this.dispatchIssue(config, issue, workspaceManager, {
          attempt: 1,
          mode: 'pr-review',
          provider,
          prReview: {
            pr_number: pr.number,
            pr_url: pr.url,
            head_ref: pr.head_ref,
            head_sha: pr.head_sha,
            base_ref: pr.base_ref || 'main',
            base_sha: pr.base_sha,
            originating_issue_number: issueNumberFromPullRequestBody(pr.body) ?? issue.number,
            review_key: reviewKey,
            lens,
            feedback_round: feedbackState?.blocking_feedback_round,
            max_feedback_rounds: config.review.max_feedback_rounds,
            feedback_priorities: feedbackState?.priorities,
            has_blocking_feedback: feedbackState?.has_blocking_feedback,
          },
        });
        if (capacity.remaining !== null) capacity.remaining -= 1;
      } catch (err) {
        const failedStore = new EpisodeStore(this.storePath(config));
        try {
          failedStore.completeReviewClaim(this.durableRepoId(config), reviewKey, 'error');
        } finally {
          failedStore.close();
        }
        if (err instanceof DispatchDeferredError) {
          log('warn', 'dispatch_deferred', { event: 'dispatch_deferred', repo_id: this.repoId ?? undefined, reason: err.message });
          continue;
        }
        const error = dispatchErrorDetails(err);
        log('error', 'pr_review_dispatch_failed', {
          ...getIssueLogFields(config, issue, this.repoId),
          event: 'pr_review_dispatch_failed',
          pr_number: issue.number,
          error,
        });
        await this.scheduleRetry(
          config,
          issue,
          1,
          `dispatch_error: ${error}`,
          workspaceManager.lastWorkspaceForIssue(issue.id) ?? undefined,
        );
      }
    }
  }

  private shouldSkipConflictResolution(issue: Issue): boolean {
    return issue.labels.includes(LABEL_NEEDS_INFO) || issue.labels.includes(LABEL_FAILED) || issue.labels.includes('blocked') || issue.labels.includes('wontfix') || issue.labels.includes(LABEL_INTERACTIVE);
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

  private async reconcileClosedEpicParents(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    candidates: Issue[],
  ): Promise<void> {
    const candidateIds = new Set(candidates.flatMap((issue) => [issue.id, issue.identifier]));
    const persisted = await readEpicStates(config.workspace.root);

    for (const state of persisted) {
      if (state.status === 'completed' || !state.issue_number) continue;
      if (candidateIds.has(state.issue_id) || candidateIds.has(state.issue_identifier)) continue;

      try {
        const issue = await tracker.fetchIssueByNumber(state.issue_number);
        if (!issue || !isTerminalIssue(config, issue)) continue;
        await upsertEpicState(
          config.workspace.root,
          reconcileEpicStateWithIssue(state, issue, config.tracker.terminal_states),
        );
        log('info', 'epic_parent_closed_reconciled', {
          ...getIssueLogFields(config, issue, this.repoId),
          event: 'epic_parent_closed_reconciled',
        });
      } catch (err) {
        if (isGithubRateLimitError(err)) throw err;
        log('error', 'epic_parent_reconciliation_failed', {
          repo_id: this.repoId ?? undefined,
          owner: config.tracker.owner,
          repo: config.tracker.repo,
          issue: state.issue_identifier,
          event: 'epic_parent_reconciliation_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
    } else if (hasNonQueueableLifecycleLabel(labels) || hasAnyLabel(labels, config.tracker.ignored_labels)) {
      skippedReason = 'ignored_label';
    } else if (stackPlan && !stackPlan.can_queue) {
      skippedReason = stackPlan.skipped_reason;
    } else if (labels.includes(LABEL_READY) || labels.includes(LABEL_RUNNING)) {
      if (hasOpenNativeDependency(config, issue)) {
        skippedReason = 'native_dependency';
      } else {
        queued = true;
      }
    } else if (!config.tracker.epics.auto_label_children) {
      skippedReason = 'auto_label_disabled';
    } else {
      try {
        await this.applyLabels(config, issue.number, { add: [LABEL_READY] });
        labels.push(LABEL_READY);
        if (hasOpenNativeDependency(config, issue)) {
          skippedReason = 'native_dependency';
        } else {
          queued = true;
        }
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
      let candidate = candidates.find((c) => c.id === entry.issue_id || c.number === entry.issue_number) ?? null;
      if (!candidate) {
        try {
          candidate = await tracker.fetchIssueByNumber(entry.issue_number);
        } catch (error) {
          log('warn', 'retry_dispatch_issue_fetch_failed', {
            repo_id: this.repoId ?? undefined,
            issue_id: entry.issue_id,
            issue_number: entry.issue_number,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
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
        this.deleteDurableRetry(config, entry.issue_id);
        continue;
      }

      if (!config.tracker.active_states.includes(candidate.state) || hasNonQueueableLifecycleLabel(entry.mode === 'grooming' ? candidate.labels.filter(l => l !== GROOMING_LABEL) : candidate.labels) || hasAnyLabel(candidate.labels, config.tracker.ignored_labels)) {
        this.deleteDurableRetry(config, entry.issue_id);
        continue;
      }

      if (entry.mode === 'grooming' && !candidate.labels.includes(GROOMING_LABEL)) { this.deleteDurableRetry(config, entry.issue_id); continue; }
      if (entry.mode !== 'grooming' && !candidate.labels.includes(LABEL_READY)) {
        await this.applyLabels(config, candidate.number!, { add: [LABEL_READY] });
        candidate = { ...candidate, labels: [...candidate.labels, LABEL_READY] };
      }

      const provider = entry.mode === 'grooming' ? config.agents.providers[config.agents.default]! : selectAgentProvider(config, candidate);
      const blocked = this.dispatchBlockReason(config, candidate, provider, capacity);
      if (blocked === 'global_capacity' || blocked === 'state_capacity') return;
      if (blocked === 'provider_capacity' || blocked === 'usage_limit') continue;
      const stackContext = await this.resolveStackContext(config, tracker, candidate, provider.id);
      if (stackContext?.blocked_reason) continue;
      let prReview: PullRequestReviewDispatchOptions | undefined;
      if (entry.mode === 'pr-review') {
        let pr: PullRequestRef | null;
        try {
          pr = await tracker.fetchPullRequest(entry.issue_number);
        } catch (error) {
          log('warn', 'retry_dispatch_pr_fetch_failed', {
            repo_id: this.repoId ?? undefined,
            issue_id: entry.issue_id,
            pr_number: entry.issue_number,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!pr) {
          this.deleteDurableRetry(config, entry.issue_id);
          continue;
        }
        const state = await this.readPullRequestReviewState(config, pr.number).catch(() => null);
        const lens = nextReviewLens(config, pr, state);
        const reviewKey = reviewExecutionKey(config, pr, lens);
        const reviewStore = new EpisodeStore(this.storePath(config));
        let claimed = false;
        try {
          claimed = reviewStore.claimReview(this.durableRepoId(config), reviewKey, 'running');
        } finally {
          reviewStore.close();
        }
        if (!claimed) {
          continue;
        }
        prReview = {
          pr_number: pr.number,
          pr_url: pr.url,
          head_ref: pr.head_ref,
          head_sha: pr.head_sha,
          base_ref: pr.base_ref || 'main',
          base_sha: pr.base_sha,
          originating_issue_number: issueNumberFromPullRequestBody(pr.body) ?? candidate.number,
          review_key: reviewKey,
          lens,
        };
      }
      try {
        await this.dispatchIssue(config, candidate, workspaceManager, {
          attempt: entry.attempt,
          mode: entry.mode,
          provider,
          prReview,
          stackContext: stackContext?.context ?? null,
        });
        this.deleteDurableRetry(config, entry.issue_id);
        if (capacity.remaining !== null) capacity.remaining -= 1;
        if (provider.usage_limit_exit_codes?.length) return;
      } catch (err) {
        if (prReview?.review_key) {
          const reviewStore = new EpisodeStore(this.storePath(config));
          try {
            reviewStore.completeReviewClaim(this.durableRepoId(config), prReview.review_key, 'error');
          } finally {
            reviewStore.close();
          }
        }
        if (err instanceof DispatchDeferredError) {
          log('warn', 'dispatch_deferred', { event: 'dispatch_deferred', repo_id: this.repoId ?? undefined, reason: err.message });
          continue;
        }
        const error = dispatchErrorDetails(err);
        log('error', 'issue_dispatch_failed', {
          ...getIssueLogFields(config, candidate, this.repoId),
          event: 'issue_dispatch_failed',
          error,
        });
        await this.scheduleRetry(
          config,
          candidate,
          entry.attempt,
          `dispatch_error: ${error}`,
          entry.workspace_path ?? workspaceManager.lastWorkspaceForIssue(candidate.id) ?? undefined,
        );
      }
    }
  }

  private async dispatchGroomingIssues(config: WorkflowConfig, issues: Issue[], manager: WorkspaceManager, capacity: DispatchCapacity): Promise<void> {
    const provider = config.agents.providers[config.agents.default]!;
    for (const issue of issues) {
      if (this.running.has(issue.id) || this.retries.has(issue.id)) continue;
      if (this.dispatchBlockReason(config, issue, provider, capacity)) return;
      try {
        await this.dispatchIssue(config, issue, manager, { attempt: 1, mode: 'grooming', provider });
        if (capacity.remaining !== null) capacity.remaining--;
      } catch (error) {
        if (error instanceof DispatchDeferredError) return;
        await this.scheduleRetry(config, issue, 1, 'grooming_dispatch_failed', manager.lastWorkspaceForIssue(issue.id) ?? undefined, 'grooming');
      }
    }
  }

  private async finishGrooming(config: WorkflowConfig, issue: Issue, workspace: string, lastMessage: string): Promise<void> {
    const state = await this.mustReadRunState(workspace);
    const client = new GithubIssueTrackerClient(config.tracker);
    const current = await client.fetchIssueByNumber(issue.number!);
    if (!current || current.state !== 'open') throw new Error('Grooming target is no longer open');
    const marker = `<!-- symphony-grooming:${state.grooming_source_sha ?? state.session_id} -->`;
    // After a crash, the durable finalizing state can safely replay this comment/label transition.
    const replay = state.grooming_result;
    if (!current.labels.includes(GROOMING_LABEL) && !replay) throw new Error('Grooming was withdrawn');
    if (hasNonQueueableLifecycleLabel(current.labels.filter(l => l !== GROOMING_LABEL && !(replay?.outcome === 'human' && l === LABEL_READY_FOR_HUMAN)))) throw new Error('Grooming target needs manual attention');
    if (!replay && groomingSource(current) !== state.grooming_source_sha) throw new Error('Issue changed during grooming; re-read its context');
    if (replay) {
      const original = state.grooming_input_labels ?? [];
      if (groomingSource({ ...current, labels: original }) !== state.grooming_source_sha) throw new Error('Capture changed during grooming finalization');
      const operational = new Set([GROOMING_LABEL, LABEL_READY, LABEL_RUNNING, LABEL_READY_FOR_HUMAN]);
      if (current.labels.some(l => !operational.has(l) && !original.includes(l) && !replay.labels.includes(l)) || original.some(l => !operational.has(l) && !current.labels.includes(l))) throw new Error('Issue labels changed during grooming finalization');
    }
    const comments = await client.listIssueComments(issue.number!);
    if (comments.some(comment => comment.id > (state.last_seen_comment_id ?? 0) && comment.id !== state.status_comment_id && !comment.body.startsWith(marker))) {
      throw new Error('New issue conversation arrived during grooming');
    }
    const known = new Set((await client.listLabels()).map(label => label.name));
    const result = parseGroomingResult(replay ? `SYMPHONY_GROOMING_RESULT\n${JSON.stringify(replay)}\nEND_SYMPHONY_GROOMING_RESULT` : await this.readLastMessage(lastMessage), config, known);
    const overrides = current.labels.filter(l => l.startsWith('agent:'));
    if (overrides.length && result.labels.some(l => l.startsWith('agent:') && !overrides.includes(l))) throw new Error('Grooming conflicts with the reporter agent override');
    const selectedPriority = result.labels.find(l => Object.keys(config.tracker.priority_labels ?? {}).includes(l));
    const existingPriority = current.labels.filter(l => Object.keys(config.tracker.priority_labels ?? {}).includes(l));
    if (existingPriority.some(l => l !== selectedPriority)) throw new Error('Grooming must preserve an existing priority or request clarification');
    await updateRunState(workspace, cur => cur ? { ...cur, grooming_result: result } : null);
    await client.upsertStatusComment(issue.number!, marker, `${marker}\n${groomingBrief(result)}`);
    // Clear the intake gate last: a partial write cannot dispatch implementation early.
    const next = result.outcome === 'ready' ? [...config.tracker.required_labels, ...(config.tracker.any_required_labels?.slice(0, 1) ?? []), LABEL_READY] : [LABEL_READY_FOR_HUMAN];
    await this.applyLabels(config, issue.number!, { add: [...result.labels, ...next], remove: [LABEL_RUNNING, ...(result.outcome === 'human' ? [LABEL_READY] : [])] });
    await this.applyLabels(config, issue.number!, { remove: [GROOMING_LABEL] });
    await this.updateLifecycleState(workspace, { add: [...result.labels, ...next], remove: [GROOMING_LABEL, LABEL_RUNNING], workflowState: result.outcome === 'ready' ? LABEL_READY : LABEL_READY_FOR_HUMAN });
    const briefPath = path.join(state.session_artifact_dir ?? path.dirname(lastMessage), 'groomed-brief.md');
    await fs.writeFile(briefPath, groomingBrief(result), 'utf8');
    await updateRunState(workspace, cur => cur ? { ...cur, last_message_path: briefPath } : null);
    await this.completeWorkflowState(workspace);
    this.appendEpisodeEvent(config, `${issue.identifier}:attempt:${state.attempt}`, 'workflow.completed', { issue_number: issue.number, outcome: `grooming-${result.outcome}` });
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
        if (provider.usage_limit_exit_codes?.length) return;
      } catch (err) {
        if (err instanceof DispatchDeferredError) {
          log('warn', 'dispatch_deferred', { event: 'dispatch_deferred', repo_id: this.repoId ?? undefined, reason: err.message });
          continue;
        }
        const error = dispatchErrorDetails(err);
        log('error', 'issue_dispatch_failed', {
          ...getIssueLogFields(config, issue, this.repoId),
          event: 'issue_dispatch_failed',
          error,
        });
        await this.scheduleRetry(
          config,
          issue,
          1,
          `dispatch_error: ${error}`,
          workspaceManager.lastWorkspaceForIssue(issue.id) ?? undefined,
        );
      }
    }
  }

  private selectWorkspaceStrategy(
    config: WorkflowConfig,
    options: { mode: AgentMode; stackContext: StackContext | null },
  ): WorkspaceStrategy {
    if (options.mode === 'planning' || options.mode === 'grooming') return config.workspace.strategy.planning;
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
    if (issue.labels.includes(GROOMING_LABEL) && opts.mode !== 'grooming') throw new DispatchDeferredError('Issue requires grooming before implementation');
    if (!(await this.hasStorageCapacity(config))) throw new DispatchDeferredError('Insufficient free disk space');
    const provider = opts.provider ?? selectAgentProvider(config, issue);
    const stackContext = opts.stackContext ?? null;
    const issueFields = getIssueLogFields(config, issue, this.repoId);
    const isConflictResolution = opts.mode === 'resolve-conflicts';
    const isPullRequestReview = opts.mode === 'pr-review';
    const isInteractiveHandoff = !isConflictResolution && !isPullRequestReview && issue.labels.includes(LABEL_INTERACTIVE);
    const isGroomingRun = opts.mode === 'grooming';
    if (isGroomingRun && !provider.handoff_command) throw new SymphonyConfigError('Grooming requires a read-only handoff_command');
    const isPlanningRun = !isGroomingRun && !isConflictResolution && !isPullRequestReview && !isInteractiveHandoff && isPlanningIssue(issue.labels);
    const agentMode: AgentMode = isGroomingRun ? 'grooming' : isConflictResolution
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
    const sessionId = randomUUID();
    const sessionArtifactDir = sessionArtifactDirectory(workspacePath, opts.attempt, sessionId);
    const stableLastMessagePath = path.join(workspacePath, '.symphony', 'last_message.md');
    const lastMessagePath = path.join(sessionArtifactDir, 'last_message.md');
    const preAgentHookLogs: Array<{ source: string; name: string }> = [];
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
      review_prompt_path: '',
      review_pr_number: '',
      review_pr_url: '',
      review_pr_head_ref: '',
      review_pr_head_sha: '',
      review_pr_base_ref: '',
      review_pr_base_sha: '',
      review_issue_number: '',
      review_execution_key: '',
      session_id: sessionId,
      run_artifact_dir: sessionArtifactDir,
      last_message_path: lastMessagePath,
    };
    const hookEnv: Record<string, string> = {
      SYMPHONY_AGENT_MODE: agentMode,
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
      SYMPHONY_REVIEW_ENABLED: config.review.enabled ? '1' : '0',
      SYMPHONY_REVIEW_PROMPT_PATH: '',
      SYMPHONY_REVIEW_PR_NUMBER: '',
      SYMPHONY_REVIEW_PR_URL: '',
      SYMPHONY_REVIEW_PR_HEAD_REF: '',
      SYMPHONY_REVIEW_PR_HEAD_SHA: '',
      SYMPHONY_REVIEW_PR_BASE_REF: '',
      SYMPHONY_REVIEW_PR_BASE_SHA: '',
      SYMPHONY_REVIEW_ISSUE_NUMBER: '',
      SYMPHONY_REVIEW_EXECUTION_KEY: '',
      SYMPHONY_SESSION_ID: sessionId,
      SYMPHONY_RUN_ARTIFACT_DIR: sessionArtifactDir,
      SYMPHONY_LAST_MESSAGE_PATH: lastMessagePath,
    };

    const skipsWorkspaceHooks = workspaceStrategy === 'none_or_readonly';
    if (!skipsWorkspaceHooks) await workspaceManager.prepareCheckout(workspacePath, this.shutdownController.signal);
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

      const rendered = await renderTemplate(config.hooks.after_create, { issue, symphony: hookSymphonyContext });
      const afterCreateLogPath = hookLogPath(workspacePath, 'after_create');
      preAgentHookLogs.push({ source: afterCreateLogPath, name: 'after_create.log' });
      log('info', 'workspace_after_create_hook_started', { ...workspaceFields, event: 'workspace_after_create_hook_started', hook_log_path: afterCreateLogPath });
      try {
        await runHookScript(rendered, workspacePath, config.hooks.timeout_ms, {
          env: hookEnv,
          logPath: afterCreateLogPath,
          streamOutput: shouldStreamHookOutput(),
          signal: this.shutdownController.signal,
        });
      } catch (err) {
        log('error', 'workspace_after_create_hook_failed', {
          ...workspaceFields,
          event: 'workspace_after_create_hook_failed',
          hook_log_path: afterCreateLogPath,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      log('info', 'workspace_after_create_hook_completed', { ...workspaceFields, event: 'workspace_after_create_hook_completed', hook_log_path: afterCreateLogPath });
    }

    const previousWorkspaceState = await readRunState(workspacePath);
    const existingState =
      previousWorkspaceState?.issue_id === issue.id || previousWorkspaceState?.issue_number === issue.number
        ? previousWorkspaceState
        : null;
    const isPausedResume = existingState?.status === 'paused' || existingState?.status === 'retry-wait';

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
      const rendered = await renderTemplate(config.hooks.before_run, { issue, symphony: hookSymphonyContext });
      const beforeRunLogPath = hookLogPath(workspacePath, 'before_run');
      preAgentHookLogs.push({ source: beforeRunLogPath, name: 'before_run.log' });
      log('info', 'workspace_before_run_hook_started', { ...workspaceFields, event: 'workspace_before_run_hook_started', hook_log_path: beforeRunLogPath });
      try {
        await runHookScript(rendered, workspacePath, config.hooks.timeout_ms, {
          env: hookEnv,
          logPath: beforeRunLogPath,
          streamOutput: shouldStreamHookOutput(),
          signal: this.shutdownController.signal,
        });
      } catch (err) {
        log('error', 'workspace_before_run_hook_failed', {
          ...workspaceFields,
          event: 'workspace_before_run_hook_failed',
          hook_log_path: beforeRunLogPath,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      log('info', 'workspace_before_run_hook_completed', { ...workspaceFields, event: 'workspace_before_run_hook_completed', hook_log_path: beforeRunLogPath });
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
    await fs.mkdir(sessionArtifactDir, { recursive: true });
    await pruneSessionArtifacts(path.join(workspacePath, '.symphony', 'runs'), { activeDir: sessionArtifactDir, maxBytes: storagePolicy(config.workspace.storage_maintenance).max_artifact_gib * 1024 ** 3 });
    for (const hookLog of preAgentHookLogs) {
      await fs.copyFile(hookLog.source, path.join(sessionArtifactDir, hookLog.name)).catch(() => {});
    }
    const runContext = await buildRunContext({
      workspacePath,
      comments,
      lastSeenCommentId: existingState?.last_seen_comment_id ?? null,
      pullRequestReviewComments,
      lastSeenPullRequestReviewCommentId: existingState?.last_seen_pr_review_comment_id ?? null,
      lastMessagePath: existingState?.last_message_path ?? stableLastMessagePath,
    });

    const handoffInstructions = isInteractiveHandoff
      ? '\n\n---\n\n## Interactive Handoff Instructions\n\nCreate a concise orientation summary for the user to continue this issue interactively. Do not edit files, run write commands, commit, push, or open a PR in this handoff pass.\n'
      : '';
    const intakeInstructions = isGroomingRun ? groomingInstructions((await new GithubIssueTrackerClient(config.tracker).listLabels()).map(l => l.name), config) : '';
    const planningInstructions = isPlanningRun
      ? '\n\n---\n\n## Planning / Technical Specification Instructions\n\nThis is a planning-only Symphony run. These instructions supersede any workflow instructions that ask you to edit files, commit, push, or open a pull request.\n\n- Inspect the repository and issue context enough to produce a concrete technical specification.\n- Do not edit files, run write commands, commit, push, create branches, or open a pull request.\n- Write the final answer as a detailed technical specification suitable for the issue thread.\n- Include: problem statement, relevant existing code/architecture, proposed implementation, files likely to change, API/data model implications, UX implications when relevant, test plan, risks, open questions, and suggested implementation tickets if the work should be split.\n- If implementation needs a product, architecture, security, data-loss, cost, or irreversible decision, use the SYMPHONY_PAUSE protocol instead of guessing.\n'
      : '';
    const nonBlockingPriorityText = config.review.non_blocking_feedback_priorities.map((priority) => priority.toUpperCase()).join('/');
    const blockingPriorityText = ['p0', 'p1', 'p2', 'p3']
      .filter((priority) => !config.review.non_blocking_feedback_priorities.includes(priority))
      .map((priority) => priority.toUpperCase())
      .join('/');
    const pullRequestReviewInstructions =
      isPullRequestReview && opts.prReview
        ? `\n\n---\n\n## Pull Request Review Instructions\n\nYou are addressing review feedback on PR #${opts.prReview.pr_number}${opts.prReview.pr_url ? ` (${opts.prReview.pr_url})` : ''}.\n\n- The workspace has been checked out to the PR head branch \`${opts.prReview.head_ref}\`${opts.prReview.head_sha ? ` at \`${opts.prReview.head_sha}\`` : ''}.\n- This is blocking-feedback round ${opts.prReview.feedback_round ?? 1}/${opts.prReview.max_feedback_rounds ?? config.review.max_feedback_rounds}.\n- Address the new PR review comments and prioritized PR conversation comments included in the run context.\n- ${blockingPriorityText || 'No configured priority'} and unprioritized inline correctness, security, data-loss, and regression findings are blocking: fix them, verify the fix, commit, and push to the existing PR branch.\n- ${opts.prReview.has_blocking_feedback === false ? 'This batch contains only configured non-blocking feedback.' : 'This batch contains blocking or unprioritized inline feedback.'}\n- ${nonBlockingPriorityText || 'No priority'} findings are configured as non-blocking. Prefer creating a focused linked follow-up issue with exactly one priority label over extending the PR or causing another review cycle. Only fix one inline when it is truly trivial and cannot destabilize the reviewed change.\n- Before creating a follow-up issue, search open issues to avoid duplicates. Link both the PR and its originating issue, preserve enough context to implement it independently, and do not add \`ready-for-agent\` unless it is genuinely implementation-ready.\n- Do not open a replacement PR.\n`
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
      : `${await renderPrompt(this.lastGoodWorkflow?.prompt_template ?? '', issue, { symphony: symphonyContext })}${runContext.text}${stackInstructions}${handoffInstructions}${planningInstructions}${pullRequestReviewInstructions}${intakeInstructions}`;
    const generatedPromptPath = await workspaceManager.writePrompt(workspacePath, prompt);
    const promptPath = path.join(sessionArtifactDir, 'prompt.md');
    await fs.copyFile(generatedPromptPath, promptPath);
    const agentLogPath = path.join(sessionArtifactDir, isCodexProvider(provider) ? 'agent.jsonl' : 'agent.stdout.log');
    await fs.mkdir(path.dirname(agentLogPath), { recursive: true });
    const codexCompatible = isCodexProvider(provider);
    const codexJsonlPath = codexCompatible ? agentLogPath : path.join(workspacePath, '.symphony', 'codex.jsonl');

    let agentThreadId =
      existingState?.agent_provider === provider.id
        ? existingState?.agent_thread_id ?? existingState?.codex_thread_id ?? null
        : provider.id === 'codex'
          ? existingState?.codex_thread_id ?? null
          : null;
    if (existingState?.agent_mode === 'grooming' && !isGroomingRun) agentThreadId = null;
    if (!agentThreadId && codexCompatible) agentThreadId = stackContext?.reusable_thread_id ?? null;
    let codexThreadId = codexCompatible ? agentThreadId : null;
    const pauseReason: PauseReason = isInteractiveHandoff ? 'interactive' : null;
    const commandTemplate = isInteractiveHandoff || isPlanningRun || isGroomingRun
      ? provider.handoff_command ?? provider.command
      : agentThreadId && provider.resume_command
        ? provider.resume_command
        : provider.command;
    symphonyContext.prompt_path = promptPath;
    Object.assign(symphonyContext, {
      session_id: sessionId,
      run_artifact_dir: sessionArtifactDir,
      agent_log_path: agentLogPath,
      last_message_path: lastMessagePath,
    });
    symphonyContext.agent_thread_id = agentThreadId ?? '';
    symphonyContext.codex_thread_id = codexThreadId ?? '';
    const renderedCommand = await renderTemplate(commandTemplate, {
      issue,
      symphony: symphonyContext,
    });

    const env: Record<string, string> = {
      ...hookEnv,
      SYMPHONY_PROMPT_PATH: promptPath,
      SYMPHONY_SESSION_ID: sessionId,
      SYMPHONY_RUN_ARTIFACT_DIR: sessionArtifactDir,
      SYMPHONY_AGENT_LOG_PATH: agentLogPath,
      SYMPHONY_LAST_MESSAGE_PATH: lastMessagePath,
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
      issue_title: issue.title,
      issue_state: issue.state,
      labels: issue.labels,
      workflow_state: issue.workflow_state,
      workspace_path: workspacePath,
      workspace_strategy: workspaceStrategy,
      attempt: opts.attempt,
      session_id: sessionId,
      agent_provider: provider.id,
      agent_provider_group: provider.provider_group,
      agent_provider_kind: provider.provider_kind,
      agent_thread_id: agentThreadId,
      grooming_source_sha: isGroomingRun ? groomingSource(issue) : undefined,
      grooming_input_labels: isGroomingRun ? issue.labels : undefined,
      agent_mode: agentMode,
      agent_log_path: agentLogPath,
      codex_thread_id: codexThreadId,
      codex_mode: codexCompatible ? agentMode : null,
      pause_reason: pauseReason,
      worker_pid: null,
      session_artifact_dir: sessionArtifactDir,
      agent_finished_at: null,
      agent_outcome: null,
      workflow_outcome: null,
      retry_reason: null,
      retry_not_before: null,
      finalization_context: {
        mode: agentMode,
        review_pr: opts.prReview ?? null,
      },
      finalization_step: 'pending',
      status: 'agent-running',
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
    await fs.writeFile(path.join(sessionArtifactDir, 'manifest.json'), `${JSON.stringify({
      version: 1,
      session_id: sessionId,
      issue_identifier: issue.identifier,
      issue_number: issue.number,
      attempt: opts.attempt,
      mode: agentMode,
      provider: provider.id,
      created_at: initialState.started_at,
      phase: initialState.status,
      agent_outcome: initialState.agent_outcome,
      workflow_outcome: initialState.workflow_outcome,
      prompt_path: promptPath,
      agent_log_path: agentLogPath,
      last_message_path: lastMessagePath,
    }, null, 2)}\n`, { mode: 0o600 });

    try {
      if (isInteractiveHandoff) {
        await this.applyLabels(config, issue.number, { remove: [LABEL_READY, LABEL_RUNNING] });
        await this.updateLifecycleState(workspacePath, { remove: [LABEL_READY, LABEL_RUNNING], workflowState: 'interactive' });
        await this.upsertStatus(config, issue, initialState, `Interactive handoff requested. Preparing a ${provider.id} session and pausing autonomous work.`);
      } else if (isPlanningRun || isGroomingRun) {
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
      sessionId,
      stdoutPath: agentLogPath,
      stderrPath: path.join(sessionArtifactDir, 'agent.stderr.log'),
      logFields: { ...workspaceFields, event: 'worker_started', status: 'agent-running', attempt: opts.attempt, agent_provider: provider.id },
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
    const episodeId = `${issue.identifier}:attempt:${opts.attempt}`;
    this.appendEpisodeEvent(config, episodeId, 'workflow.started', {
      issue_number: issue.number,
      issue_identifier: issue.identifier,
      attempt: opts.attempt,
      mode: agentMode,
      provider: provider.id,
      session_id: agent.session_id,
      workspace_path: workspacePath,
    });
    this.appendEpisodeEvent(config, episodeId, 'agent.started', {
      issue_number: issue.number,
      issue_identifier: issue.identifier,
      attempt: opts.attempt,
      mode: agentMode,
      provider: provider.id,
      session_id: agent.session_id,
      workspace_path: workspacePath,
      prompt_path: promptPath,
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
        await fs.access(lastMessagePath).catch(async () => {
          await fs.copyFile(stableLastMessagePath, lastMessagePath).catch(() => {});
        });
        this.appendEpisodeEvent(config, episodeId, code === 0 && !signal ? 'agent.completed' : 'agent.failed', {
          issue_number: issue.number,
          issue_identifier: issue.identifier,
          attempt: opts.attempt,
          mode: agentMode,
          provider: provider.id,
          session_id: agent.session_id,
          exit_code: code,
          signal,
          workspace_path: workspacePath,
          last_message_path: lastMessagePath,
        });
        const cancelledReason = session.cancelled_reason;
        await updateRunState(workspacePath, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: cancelledReason ? 'cancelled' : code === 0 && !signal ? 'finalizing' : 'failed',
            agent_finished_at: new Date().toISOString(),
            agent_outcome: cancelledReason ? 'cancelled' : code === 0 && !signal ? 'completed' : 'failed',
            finished_at: null,
            last_exit_code: code ?? null,
            last_signal: signal ?? null,
            finalization_step: code === 0 && !signal ? 'pending' : cur.finalization_step ?? null,
            updated_at: new Date().toISOString(),
          };
        });
        await captureVerificationSnapshot(workspacePath, sessionArtifactDir, { code, signal });

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
          } else {
            await updateRunState(workspacePath, (cur) => cur ? {
              ...cur,
              status: 'cancelled',
              workflow_outcome: 'cancelled',
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            } : null);
            this.appendEpisodeEvent(config, episodeId, 'workflow.cancelled', {
              issue_number: issue.number, session_id: agent.session_id, reason: cancelledReason,
            });
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
          this.appendEpisodeEvent(config, episodeId, 'workflow.finalizing', {
            issue_number: issue.number,
            issue_identifier: issue.identifier,
            session_id: agent.session_id,
            workspace_path: workspacePath,
          });
          log('info', 'worker_completed', { ...endFields, event: 'worker_completed', status: 'completed', code });
          if (isInteractiveHandoff) {
            await this.pauseForInteractive(config, issue, workspacePath, 'Interactive handoff is ready.');
            this.appendEpisodeEvent(config, episodeId, 'workflow.paused', { issue_number: issue.number, session_id: agent.session_id, reason: 'interactive' });
            return;
          }

          const latestIssue = issue.number ? await new GithubIssueTrackerClient(config.tracker).fetchIssueByNumber(issue.number) : null;
          if (latestIssue?.labels.includes(LABEL_INTERACTIVE)) {
            await this.pauseForInteractive(config, latestIssue, workspacePath, 'Interactive label detected after the autonomous run completed.');
            this.appendEpisodeEvent(config, episodeId, 'workflow.paused', { issue_number: issue.number, session_id: agent.session_id, reason: 'interactive' });
            return;
          }

          const pauseRequest = parsePauseRequest(await this.readLastMessage(lastMessagePath));
          if (pauseRequest) {
            const marker = `<!-- symphony-pause:${agent.session_id} -->`;
            await new GithubIssueTrackerClient(config.tracker).upsertStatusComment(issue.number!, marker, `${marker}\n${formatPauseComment(pauseRequest)}`);
            await this.applyLabels(config, issue.number!, { add: [LABEL_NEEDS_INFO], remove: [LABEL_READY, LABEL_RUNNING] });
            await this.updateLifecycleState(workspacePath, {
              add: [LABEL_NEEDS_INFO],
              remove: [LABEL_READY, LABEL_RUNNING],
              workflowState: LABEL_NEEDS_INFO,
            });
            await updateRunState(workspacePath, (cur) =>
              cur ? { ...cur, status: 'paused', pause_reason: 'needs-info', workflow_outcome: 'paused', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() } : null,
            );
            await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), 'Paused for user input. Symphony posted a question on this issue.');
            this.appendEpisodeEvent(config, episodeId, 'workflow.paused', { issue_number: issue.number, session_id: agent.session_id, reason: 'needs-info' });
            return;
          }

          if (isGroomingRun) {
            await this.finishGrooming(config, issue, workspacePath, lastMessagePath);
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
            await this.completeWorkflowState(workspacePath);
            this.appendEpisodeEvent(config, episodeId, 'workflow.completed', { issue_number: issue.number, session_id: agent.session_id, outcome: 'planning-posted' });
            return;
          }

          let continuationQueued = false;
          const reviewPr = await this.findReviewPullRequest(config, issue, opts.prReview);
          if (reviewPr) {
            const reviewPrompt = config.review.enabled
              ? await this.writePullRequestReviewPrompt(config, workspacePath, issue, reviewPr, opts.prReview?.lens)
              : null;
            const reviewPromptPath = reviewPrompt?.path ?? '';
            const reviewLens = reviewPrompt?.lens ?? opts.prReview?.lens ?? config.review.lenses[0] ?? 'staff-engineer';
            const capturedReview: PullRequestReviewDispatchOptions = {
              pr_number: reviewPr.number,
              pr_url: reviewPr.url,
              head_ref: reviewPr.head_ref,
              head_sha: reviewPr.head_sha,
              base_ref: reviewPr.base_ref || 'main',
              base_sha: reviewPr.base_sha,
              originating_issue_number: opts.prReview?.originating_issue_number ?? issue.number ?? null,
              review_key: opts.prReview?.review_key ?? reviewExecutionKey(config, reviewPr, reviewLens),
              lens: reviewLens,
              feedback_round: opts.prReview?.feedback_round,
              max_feedback_rounds: opts.prReview?.max_feedback_rounds,
              feedback_priorities: opts.prReview?.feedback_priorities,
              has_blocking_feedback: opts.prReview?.has_blocking_feedback,
            };
            await updateRunState(workspacePath, (cur) => cur ? {
              ...cur,
              finalization_context: { mode: agentMode, review_pr: capturedReview },
              updated_at: new Date().toISOString(),
            } : null);
            hookSymphonyContext.review_prompt_path = reviewPromptPath;
            hookSymphonyContext.review_pr_number = String(reviewPr.number);
            hookSymphonyContext.review_pr_url = reviewPr.url ?? '';
            hookSymphonyContext.review_pr_head_ref = reviewPr.head_ref;
            hookSymphonyContext.review_pr_head_sha = reviewPr.head_sha ?? '';
            hookSymphonyContext.review_pr_base_ref = reviewPr.base_ref || 'main';
            hookSymphonyContext.review_pr_base_sha = reviewPr.base_sha ?? opts.prReview?.base_sha ?? '';
            hookSymphonyContext.review_issue_number = String(opts.prReview?.originating_issue_number ?? issue.number ?? '');
            hookSymphonyContext.review_execution_key = capturedReview.review_key;
            env.SYMPHONY_REVIEW_PROMPT_PATH = reviewPromptPath;
            env.SYMPHONY_REVIEW_PR_NUMBER = String(reviewPr.number);
            env.SYMPHONY_REVIEW_PR_URL = reviewPr.url ?? '';
            env.SYMPHONY_REVIEW_PR_HEAD_REF = reviewPr.head_ref;
            env.SYMPHONY_REVIEW_PR_HEAD_SHA = reviewPr.head_sha ?? '';
            env.SYMPHONY_REVIEW_PR_BASE_REF = reviewPr.base_ref || 'main';
            env.SYMPHONY_REVIEW_PR_BASE_SHA = reviewPr.base_sha ?? opts.prReview?.base_sha ?? '';
            env.SYMPHONY_REVIEW_ISSUE_NUMBER = String(opts.prReview?.originating_issue_number ?? issue.number ?? '');
            env.SYMPHONY_REVIEW_LENS = reviewLens;
            env.SYMPHONY_REVIEW_EXECUTION_KEY = capturedReview.review_key;
          }

          if (config.hooks.after_run) {
            const afterRunLogPath = path.join(sessionArtifactDir, 'after_run.log');
            log('info', 'workspace_after_run_hook_started', { ...endFields, event: 'workspace_after_run_hook_started', hook_log_path: afterRunLogPath });
            try {
              await updateRunState(workspacePath, (cur) => cur ? { ...cur, finalization_step: 'hook-running', updated_at: new Date().toISOString() } : null);
              const rendered = await renderTemplate(config.hooks.after_run, { issue, symphony: hookSymphonyContext });
              const hookResult = await runHookScript(rendered, workspacePath, config.hooks.timeout_ms, {
                env,
                logPath: afterRunLogPath,
                streamOutput: shouldStreamHookOutput(),
                signal: this.shutdownController.signal,
              });
              if (reviewPr && config.review.enabled) {
                const reviewResult = parseStructuredReviewResult(hookResult.output);
                if (reviewResult?.verdict === 'block') {
                  await this.handleBlockingPullRequestReview(config, issue, reviewPr, workspacePath, reviewResult);
                  await this.completeWorkflowState(workspacePath);
                  this.appendEpisodeEvent(config, episodeId, 'workflow.completed', { issue_number: issue.number, session_id: agent.session_id, outcome: 'review-blocked' });
                  return;
                }
                if (reviewResult?.verdict === 'pass') {
                  continuationQueued = await this.handlePassingPullRequestReview(config, issue, reviewPr, workspacePath, reviewResult);
                } else if (reviewResult?.verdict === 'retry') {
                  await this.recordNonPassingVerificationReceipt(config, issue, reviewPr, workspacePath, 'error', reviewResult.summary, reviewResult);
                } else {
                  await this.recordNonPassingVerificationReceipt(
                    config,
                    issue,
                    reviewPr,
                    workspacePath,
                    'unavailable',
                    'Review hook completed without a valid SYMPHONY_REVIEW_RESULT payload',
                  );
                }
              }
              log('info', 'workspace_after_run_hook_completed', { ...endFields, event: 'workspace_after_run_hook_completed', hook_log_path: afterRunLogPath });
              await updateRunState(workspacePath, (cur) => cur ? { ...cur, finalization_step: 'hook-completed', updated_at: new Date().toISOString() } : null);
            } catch (err) {
              const error = dispatchErrorDetails(err);
              const reviewResult = reviewPr ? parseStructuredReviewResult(hookOutputFromError(err)) : null;
              if (opts.prReview?.review_key) {
                const reviewStore = new EpisodeStore(this.storePath(config));
                try {
                  reviewStore.completeReviewClaim(this.durableRepoId(config), opts.prReview.review_key, reviewResult?.verdict === 'block' ? 'block' : 'error');
                } finally {
                  reviewStore.close();
                }
              }
              if (reviewPr && reviewResult?.verdict === 'block') {
                log('info', 'workspace_after_run_hook_review_blocked', {
                  ...endFields,
                  event: 'workspace_after_run_hook_review_blocked',
                  pr_number: reviewPr.number,
                  hook_log_path: afterRunLogPath,
                  error,
                });
                await this.handleBlockingPullRequestReview(config, issue, reviewPr, workspacePath, reviewResult);
                await this.completeWorkflowState(workspacePath);
                this.appendEpisodeEvent(config, episodeId, 'workflow.completed', { issue_number: issue.number, session_id: agent.session_id, outcome: 'review-blocked' });
                return;
              }
              log('error', 'workspace_after_run_hook_failed', {
                ...endFields,
                event: 'workspace_after_run_hook_failed',
                hook_log_path: afterRunLogPath,
                error,
              });
              if (reviewPr && config.review.enabled) {
                await this.recordNonPassingVerificationReceipt(config, issue, reviewPr, workspacePath, 'error', reviewResult?.summary ?? error, reviewResult).catch(() => {});
              }
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
              await this.scheduleRetry(config, issue, opts.attempt, `after_run_failed: ${error}`, workspacePath);
              return;
            }
          }

          if (reviewPr && config.merge.enabled && requiredPassingReviews(config.merge) === 0) {
            await this.recordLocalValidation(config, issue, reviewPr, workspacePath);
          }

          if (!isConflictResolution && !isPullRequestReview && !continuationQueued) {
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
              await this.completeWorkflowState(workspacePath);
              this.appendEpisodeEvent(config, episodeId, 'workflow.completed', { issue_number: issue.number, session_id: agent.session_id, outcome: 'conflict-queued' });
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

          if (isPullRequestReview && opts.prReview) {
            const feedbackState = await this.readPullRequestFeedbackState(config, opts.prReview.pr_number).catch(() => null);
            const latestPr = await new GithubIssueTrackerClient(config.tracker).fetchPullRequest(opts.prReview.pr_number).catch(() => reviewPr);
            if (
              feedbackState?.pending &&
              !feedbackState.has_blocking_feedback &&
              latestPr?.head_sha &&
              feedbackState.observed_head_sha === latestPr.head_sha
            ) {
              continuationQueued = await this.handlePassingPullRequestReview(
                config,
                issue,
                latestPr,
                workspacePath,
                this.externalNonBlockingReviewResult(feedbackState),
              );
            }
            await this.markPullRequestFeedbackAddressed(config, opts.prReview.pr_number).catch((err) => {
              log('warn', 'pr_feedback_state_update_failed', {
                ...getIssueLogFields(config, issue, this.repoId),
                event: 'pr_feedback_state_update_failed',
                pr_number: opts.prReview!.pr_number,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }

          if (continuationQueued) return;

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
            config.merge.enabled && requiredPassingReviews(config.merge) === 0
              ? 'Autonomous run completed. Local validation passed; PR is queued for automatic merging.'
              : isPullRequestReview ? 'PR review feedback addressed. PR is ready for human review.' : 'Autonomous run completed. Issue is ready for human review.',
          );
          await updateRunState(workspacePath, (cur) => cur ? { ...cur, status: 'completed', finalization_step: 'effects-applied', workflow_outcome: 'completed', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() } : null);
          this.appendEpisodeEvent(config, episodeId, 'workflow.completed', { issue_number: issue.number, session_id: agent.session_id });
          return;
        }

        log('error', 'worker_failed', { ...endFields, event: 'worker_failed', status: 'failed', code });
        let usageLimitBackoff: { limitKey: string; backoffSeconds: number } | null = null;
        if (code !== null && provider.usage_limit_exit_codes?.includes(code) && provider.usage_limit_backoff_ms > 0) {
          const limitKey = providerLimitKey(provider);
          const backoffUntil = nowMs() + provider.usage_limit_backoff_ms;
          const backoffSeconds = Math.round(provider.usage_limit_backoff_ms / 1000);
          this.providerUsageLimitBackoffUntil.set(limitKey, backoffUntil);
          usageLimitBackoff = { limitKey, backoffSeconds };
          log('warn', 'provider_usage_limit_backoff', {
            ...endFields,
            event: 'provider_usage_limit_backoff',
            agent_provider: provider.id,
            agent_provider_group: limitKey,
            exit_code: code,
            backoff_ms: provider.usage_limit_backoff_ms,
            backoff_until: new Date(backoffUntil).toISOString(),
          });
        }

        await this.applyLabels(config, issue.number!, { add: [LABEL_READY], remove: [LABEL_RUNNING] });
        await this.updateLifecycleState(workspacePath, { add: [LABEL_READY], remove: [LABEL_RUNNING], workflowState: LABEL_READY });

        if (usageLimitBackoff) {
          await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), `Usage limit reached for ${provider.id} (exit code ${code}). Symphony will pause new ${usageLimitBackoff.limitKey} dispatches for ${usageLimitBackoff.backoffSeconds}s and retry.`);
        } else {
          await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), `Autonomous run failed with exit code ${code}. Symphony will retry.`);
        }
        await this.scheduleRetry(config, issue, opts.attempt, `nonzero_exit: ${code}`, workspacePath);
      })
      .catch(async (err) => {
        const endFields = { ...workspaceFields, session_id: agent.session_id };
        this.appendEpisodeEvent(config, episodeId, 'agent.failed', {
          issue_number: issue.number,
          issue_identifier: issue.identifier,
          attempt: opts.attempt,
          mode: agentMode,
          provider: provider.id,
          session_id: agent.session_id,
          error: err instanceof Error ? err.message : String(err),
          workspace_path: workspacePath,
        });
        await updateRunState(workspacePath, (cur) => {
          if (!cur) return null;
          return {
            ...cur,
            status: 'failed',
            agent_finished_at: cur.agent_finished_at ?? new Date().toISOString(),
            agent_outcome: cur.agent_outcome ?? 'failed',
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
        await this.scheduleRetry(config, issue, opts.attempt, `runner_error: ${dispatchErrorDetails(err)}`, workspacePath);
      })
      .finally(() => {
        this.running.delete(issue.id);
      });

    session.done = done;
  }

  private async findReviewPullRequest(
    config: WorkflowConfig,
    issue: Issue,
    prReview: PullRequestReviewDispatchOptions | undefined,
  ): Promise<PullRequestRef | null> {
    if (prReview) {
      const client = new GithubIssueTrackerClient(config.tracker);
      const fetched = await client.fetchPullRequest(prReview.pr_number).catch(() => null);
      if (fetched) return fetched;
      return {
        number: prReview.pr_number,
        title: issue.title,
        body: issue.description,
        state: issue.state,
        labels: issue.labels,
        is_draft: false,
        url: prReview.pr_url,
        head_ref: prReview.head_ref,
        head_sha: prReview.head_sha,
        base_ref: prReview.base_ref,
        base_sha: null,
        merge_state_status: null,
      };
    }

    return await this.findPullRequestForIssue(config, issue).catch(() => null);
  }

  private async reconcileAutonomousMerges(config: WorkflowConfig, tracker: GithubIssueTrackerClient): Promise<void> {
    if (!config.merge.enabled) return;
    const pullRequests = await tracker.listOpenPullRequests();
    const cleanupStore = new EpisodeStore(this.storePath(config));
    try {
      cleanupStore.clearMergeAssessmentsExcept(this.durableRepoId(config), pullRequests.map((pr) => pr.number));
    } finally {
      cleanupStore.close();
    }
    for (const pr of pullRequests) {
      if (!this.isSymphonyPullRequest(config, pr)) continue;
      const detailed = await tracker.fetchPullRequest(pr.number).catch((err) => {
        if (isGithubRateLimitError(err)) throw err;
        return null;
      });
      if (!detailed) continue;
      if (requiredPassingReviews(config.merge) === 0) {
        const issueNumber = issueNumberFromPullRequestBody(detailed.body);
        const issue = issueNumber ? await new GithubIssueTrackerClient(config.tracker).fetchIssueByNumber(issueNumber) : null;
        if (!issue || !config.tracker.active_states.includes(issue.state) || hasOpenNativeDependency(config, issue) ||
            issue.labels.some((label) => ['blocked', 'interactive', 'needs-info', 'symphony-failed', 'wontfix', LABEL_RUNNING].includes(label))) continue;
      }
      let feedbackState: PullRequestFeedbackState | null;
      try {
        feedbackState = await this.readPullRequestFeedbackState(config, detailed.number);
      } catch (err) {
        if (isGithubRateLimitError(err)) throw err;
        log('warn', 'pr_feedback_state_read_failed', {
          repo_id: this.repoId ?? undefined,
          owner: config.tracker.owner,
          repo: config.tracker.repo,
          event: 'pr_feedback_state_read_failed',
          pr_number: detailed.number,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (feedbackState?.pending) continue;
      const reviewState = await this.readPullRequestReviewState(config, detailed.number).catch((err) => {
        if (isGithubRateLimitError(err)) throw err;
        return null;
      });
      if (!reviewState || reviewState.verdict !== 'pass') continue;
      const inputFingerprint = fingerprint({
        head: detailed.head_sha,
        base: detailed.base_sha,
        policy: config.merge.policy_version ?? 'v1',
        workflow: config.workflow_sha ?? null,
        receipts: reviewState.receipts,
      });
      const assessmentStore = new EpisodeStore(this.storePath(config));
      try {
        const previous = assessmentStore.getMergeAssessment(this.durableRepoId(config), detailed.number);
        if (previous?.input_fingerprint === inputFingerprint && Date.parse(previous.next_check_at) > nowMs()) continue;
      } finally {
        assessmentStore.close();
      }
      await this.assessAutonomousMerge(config, tracker, detailed, reviewState).catch((err) => {
        log('warn', 'autonomous_merge_assessment_failed', {
          repo_id: this.repoId ?? undefined,
          owner: config.tracker.owner,
          repo: config.tracker.repo,
          event: 'autonomous_merge_assessment_failed',
          pr_number: detailed.number,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private async reconcilePullRequestFeedback(config: WorkflowConfig, tracker: GithubIssueTrackerClient): Promise<void> {
    if (!config.review.shepherd_pull_requests) return;
    const now = nowMs();
    if (now - this.lastPullRequestFeedbackScanAtMs < 5 * 60 * 1000) return;
    this.lastPullRequestFeedbackScanAtMs = now;

    let pullRequests: PullRequestRef[];
    try {
      pullRequests = await tracker.listOpenPullRequests();
    } catch (err) {
      if (isGithubRateLimitError(err)) throw err;
      log('warn', 'pr_feedback_scan_failed', {
        repo_id: this.repoId ?? undefined,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'pr_feedback_scan_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const pr of pullRequests) {
      if (!this.isSymphonyPullRequest(config, pr) || pr.labels.includes(LABEL_RUNNING)) continue;
      let conversationComments: IssueComment[];
      let reviewComments: IssueComment[];
      let reactions: IssueReaction[];
      try {
        [conversationComments, reviewComments, reactions] = await Promise.all([
          tracker.listIssueComments(pr.number),
          tracker.listPullRequestReviewComments(pr.number),
          tracker.listIssueReactions(pr.number),
        ]);
      } catch (err) {
        if (isGithubRateLimitError(err)) throw err;
        log('warn', 'pr_feedback_scan_incomplete', {
          repo_id: this.repoId ?? undefined,
          owner: config.tracker.owner,
          repo: config.tracker.repo,
          event: 'pr_feedback_scan_incomplete',
          pr_number: pr.number,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const feedbackState = conversationComments.map((comment) => parsePullRequestFeedbackStateComment(comment.body)).find(Boolean) ?? null;
      const reviewState = conversationComments.map((comment) => parsePullRequestReviewStateComment(comment.body)).find(Boolean) ?? null;
      const externalConversationComments = conversationComments.filter(
        (comment) => isExternalPullRequestConversationComment(comment) && feedbackPriority(comment.body) !== null,
      );
      const latestIssueCommentId = externalConversationComments.reduce((latest, comment) => Math.max(latest, comment.id), 0);
      const latestReviewCommentId = reviewComments.reduce((latest, comment) => Math.max(latest, comment.id), 0);
      const previousIssueCommentId = feedbackState?.last_issue_comment_id ?? null;
      const previousReviewCommentId = feedbackState?.last_review_comment_id ?? reviewState?.last_review_comment_id ?? null;
      const previousCodexApprovalReactionId = feedbackState?.last_codex_approval_reaction_id ?? null;
      const newIssueComments = externalConversationComments.filter((comment) => comment.id > (previousIssueCommentId ?? 0));
      const newReviewComments = reviewComments.filter((comment) => comment.id > (previousReviewCommentId ?? 0));
      const hasNewIssueComment = newIssueComments.length > 0;
      const hasNewReviewComment = newReviewComments.length > 0;
      const latestCodexApprovalReactionId = reactions
        .filter(isCodexApprovalReaction)
        .reduce((latest, reaction) => Math.max(latest, reaction.id), 0);

      if (feedbackState?.observed_head_sha && feedbackState.observed_head_sha !== pr.head_sha) {
        await this.writePullRequestFeedbackState(config, {
          ...feedbackState,
          pending: false,
          observed_head_sha: pr.head_sha,
          priorities: [],
          has_blocking_feedback: false,
          exhausted: false,
          last_codex_approval_reaction_id: latestCodexApprovalReactionId || previousCodexApprovalReactionId,
          updated_at: new Date().toISOString(),
        });
        await this.applyLabels(config, pr.number, {
          add: [LABEL_READY_FOR_HUMAN],
          remove: [LABEL_REVIEW_PASSED, LABEL_REVIEW_BLOCKING, LABEL_READY, LABEL_RUNNING],
        });
        log('info', 'pr_feedback_head_rebased', {
          repo_id: this.repoId ?? undefined,
          owner: config.tracker.owner,
          repo: config.tracker.repo,
          event: 'pr_feedback_head_rebased',
          pr_number: pr.number,
          previous_head_sha: feedbackState.observed_head_sha,
          head_sha: pr.head_sha,
        });
        continue;
      }
      const latestCodexApproval = reactions
        .filter((reaction) => isCodexApprovalReaction(reaction) && reaction.id > (previousCodexApprovalReactionId ?? 0))
        .sort((left, right) => right.id - left.id)[0] ?? null;
      let freshCodexApproval: IssueReaction | null = null;
      if (latestCodexApproval && pr.head_sha) {
        let commits;
        try {
          commits = await tracker.listPullRequestCommits(pr.number);
        } catch (err) {
          if (isGithubRateLimitError(err)) throw err;
          log('warn', 'pr_feedback_commit_scan_failed', {
            repo_id: this.repoId ?? undefined,
            owner: config.tracker.owner,
            repo: config.tracker.repo,
            event: 'pr_feedback_commit_scan_failed',
            pr_number: pr.number,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        const headCommit = commits.find((commit) => commit.sha === pr.head_sha) ?? null;
        if (isReactionFreshForHead(latestCodexApproval, headCommit?.committed_at ?? null)) {
          const approvalAt = Date.parse(latestCodexApproval.created_at!);
          const commentsAfterApproval = [...newIssueComments, ...newReviewComments].some((comment) => {
            const commentAt = comment.created_at ? Date.parse(comment.created_at) : Number.NaN;
            return !Number.isFinite(commentAt) || commentAt > approvalAt;
          });
          if (!commentsAfterApproval) freshCodexApproval = latestCodexApproval;
        }
      }
      if (!hasNewIssueComment && !hasNewReviewComment && !freshCodexApproval) continue;

      if (freshCodexApproval) {
        const issueNumber = issueNumberFromPullRequestBody(pr.body);
        const issue = issueNumber ? await tracker.fetchIssueByNumber(issueNumber).catch(() => null) : null;
        if (!issue) {
          log('warn', 'codex_approval_issue_lookup_failed', {
            repo_id: this.repoId ?? undefined,
            owner: config.tracker.owner,
            repo: config.tracker.repo,
            event: 'codex_approval_issue_lookup_failed',
            pr_number: pr.number,
            issue_number: issueNumber ?? undefined,
          });
          continue;
        }
        await this.handlePassingPullRequestReview(
          config,
          issue,
          pr,
          workspacePathForIssue(config.workspace.root, issue),
          this.externalCodexApprovalResult(freshCodexApproval),
        );
        await this.writePullRequestFeedbackState(config, {
          version: 1,
          pr_number: pr.number,
          last_issue_comment_id: latestIssueCommentId || previousIssueCommentId,
          last_review_comment_id: latestReviewCommentId || previousReviewCommentId,
          pending: false,
          feedback_round: feedbackState?.feedback_round ?? 0,
          blocking_feedback_round: feedbackState?.blocking_feedback_round ?? 0,
          observed_head_sha: pr.head_sha,
          priorities: [],
          has_blocking_feedback: false,
          exhausted: false,
          last_codex_approval_reaction_id: freshCodexApproval.id,
          updated_at: new Date().toISOString(),
        });
        this.appendEpisodeEvent(config, `pr-${pr.number}`, 'pr.codex_approval_received', {
          pr_number: pr.number,
          issue_number: issue.number,
          head_sha: pr.head_sha,
          reaction_id: freshCodexApproval.id,
        });
        log('info', 'codex_approval_received', {
          repo_id: this.repoId ?? undefined,
          owner: config.tracker.owner,
          repo: config.tracker.repo,
          event: 'codex_approval_received',
          pr_number: pr.number,
          head_sha: pr.head_sha,
          reaction_id: freshCodexApproval.id,
        });
        continue;
      }

      const classification = classifyPullRequestFeedback(
        [...newIssueComments, ...newReviewComments],
        config.review.non_blocking_feedback_priorities,
      );
      const feedbackRound = (feedbackState?.feedback_round ?? 0) + 1;
      const blockingFeedbackRound =
        (feedbackState?.blocking_feedback_round ?? 0) + (classification.has_blocking_feedback ? 1 : 0);
      const exhausted = classification.has_blocking_feedback && blockingFeedbackRound > config.review.max_feedback_rounds;
      const nextState: PullRequestFeedbackState = {
        version: 1,
        pr_number: pr.number,
        last_issue_comment_id: latestIssueCommentId || previousIssueCommentId,
        last_review_comment_id: latestReviewCommentId || previousReviewCommentId,
        pending: !exhausted,
        feedback_round: feedbackRound,
        blocking_feedback_round: blockingFeedbackRound,
        observed_head_sha: pr.head_sha,
        priorities: classification.priorities,
        has_blocking_feedback: classification.has_blocking_feedback,
        exhausted,
        last_codex_approval_reaction_id: previousCodexApprovalReactionId,
        updated_at: new Date().toISOString(),
      };
      await this.applyLabels(
        config,
        pr.number,
        exhausted
          ? {
              add: [LABEL_READY_FOR_HUMAN, ...(classification.has_blocking_feedback ? [LABEL_REVIEW_BLOCKING] : [])],
              remove: [LABEL_READY, LABEL_RUNNING, LABEL_REVIEW_PASSED],
            }
          : {
              add: [LABEL_READY, ...(classification.has_blocking_feedback ? [LABEL_REVIEW_BLOCKING] : [])],
              remove: [LABEL_READY_FOR_HUMAN, ...(classification.has_blocking_feedback ? [LABEL_REVIEW_PASSED] : [])],
            },
      );
      await this.writePullRequestFeedbackState(config, nextState);
      this.appendEpisodeEvent(config, `pr-${pr.number}`, exhausted ? 'pr.feedback_exhausted' : 'pr.feedback_queued', {
        pr_number: pr.number,
        head_sha: pr.head_sha,
        previous_issue_comment_id: previousIssueCommentId,
        latest_issue_comment_id: latestIssueCommentId || null,
        previous_review_comment_id: previousReviewCommentId,
        latest_review_comment_id: latestReviewCommentId || null,
        feedback_round: feedbackRound,
        blocking_feedback_round: blockingFeedbackRound,
        max_feedback_rounds: config.review.max_feedback_rounds,
        priorities: classification.priorities,
        blocking: classification.has_blocking_feedback,
        exhausted,
      });
      log(exhausted ? 'warn' : 'info', exhausted ? 'pr_feedback_exhausted' : 'pr_feedback_queued', {
        repo_id: this.repoId ?? undefined,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: exhausted ? 'pr_feedback_exhausted' : 'pr_feedback_queued',
        pr_number: pr.number,
        head_sha: pr.head_sha ?? '',
        issue_comments: hasNewIssueComment,
        review_comments: hasNewReviewComment,
        feedback_round: feedbackRound,
        blocking_feedback_round: blockingFeedbackRound,
        max_feedback_rounds: config.review.max_feedback_rounds,
        priorities: classification.priorities,
        blocking: classification.has_blocking_feedback,
      });
    }
  }

  private async promoteStackedPullRequests(config: WorkflowConfig, tracker: GithubIssueTrackerClient): Promise<void> {
    if (!config.merge.enabled || !config.tracker.epics.enabled) return;
    const now = nowMs();
    if (now - this.lastStackPromotionScanAtMs < 5 * 60 * 1000) return;
    this.lastStackPromotionScanAtMs = now;

    const [openPullRequests, mergedPullRequests] = await Promise.all([
      tracker.listOpenPullRequests(),
      tracker.listMergedPullRequests(),
    ]);
    for (const pr of openPullRequests) {
      if (!this.isSymphonyPullRequest(config, pr)) continue;
      const nextBase = resolvePromotedBase(pr.base_ref, mergedPullRequests);
      if (nextBase === pr.base_ref) continue;

      const updated = await tracker.updatePullRequestBase(pr.number, nextBase);
      await this.applyLabels(config, pr.number, {
        add: [LABEL_READY],
        remove: [
          LABEL_REVIEW_PASSED,
          LABEL_REVIEW_BLOCKING,
          LABEL_READY_FOR_HUMAN,
          ...pr.labels.filter(isReviewAutoFixLabel),
        ],
      });
      this.conflictQueue.delete(pr.number);
      this.appendEpisodeEvent(config, `pr-${pr.number}`, 'stack.promoted', {
        pr_number: pr.number,
        previous_base_ref: pr.base_ref,
        base_ref: updated.base_ref,
        head_sha: updated.head_sha,
        base_sha: updated.base_sha,
      });
      log('info', 'stacked_pull_request_promoted', {
        repo_id: this.repoId ?? undefined,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'stacked_pull_request_promoted',
        pr_number: pr.number,
        previous_base_ref: pr.base_ref,
        base_ref: updated.base_ref,
      });
    }
  }

  private async dispatchScheduledLoops(config: WorkflowConfig, capacity: DispatchCapacity): Promise<void> {
    if (config.loops.length === 0 || (capacity.remaining !== null && capacity.remaining <= 0)) return;
    const maxConcurrent = this.maxConcurrentAgentsOverride ?? config.agent.max_concurrent_agents;
    if (this.getRunningCount() >= maxConcurrent) return;

    const databasePath = path.join(config.workspace.root, '.symphony', 'episodes.sqlite');
    const lastTriggeredAt = new Map<string, string>();
    let recentEvents: ReturnType<EpisodeStore['list']> = [];
    let store: EpisodeStore | null = null;
    try {
      store = new EpisodeStore(databasePath);
      for (const loop of config.loops) {
        // A live preparation/agent is not an orphan from a previous process.
        if (this.runningLoops.has(loop.id)) continue;
        const triggered = store.latest({
          repo_id: this.repoId ?? `${config.tracker.owner}/${config.tracker.repo}`,
          episode_id: `loop-${loop.id}`,
          event: 'loop.triggered',
        });
        const completed = store.latest({ repo_id: this.durableRepoId(config), episode_id: `loop-${loop.id}`, event: 'loop.completed' });
        const failed = store.latest({ repo_id: this.durableRepoId(config), episode_id: `loop-${loop.id}`, event: 'loop.failed' });
        const latestTerminal = [completed, failed].filter((event): event is NonNullable<typeof event> => Boolean(event)).sort((a, b) => b.sequence - a.sequence)[0];
        if (triggered && latestTerminal && latestTerminal.sequence > triggered.sequence) {
          lastTriggeredAt.set(loop.id, triggered.created_at);
        } else if (triggered) {
          store.append({
            repo_id: this.durableRepoId(config),
            episode_id: `loop-${loop.id}`,
            event: 'loop.failed',
            payload: { loop_id: loop.id, reason: 'orphaned_trigger_recovered' },
          });
        }
      }
      recentEvents = store.list({
        repo_id: this.repoId ?? `${config.tracker.owner}/${config.tracker.repo}`,
        limit: 20,
        order: 'desc',
      });
    } finally {
      store?.close();
    }

    const due = dueScheduledLoops(config.loops, lastTriggeredAt, nowMs());
    for (const loop of due) {
      if (this.runningLoops.has(loop.id)) continue;
      if (capacity.remaining !== null && capacity.remaining <= 0) return;
      if (this.getRunningCount() >= maxConcurrent) return;
      const provider = config.agents.providers[loop.provider ?? config.agents.default];
      if (!provider) continue;
      const limitKey = providerLimitKey(provider);
      const backoffUntil = this.providerUsageLimitBackoffUntil.get(limitKey);
      if ((backoffUntil !== undefined && nowMs() < backoffUntil) || this.providerUsageLimitCheckBlocked.has(limitKey)) continue;
      if (provider.max_concurrent !== null) {
        const runningIssues = [...this.running.values()].filter((session) => session.agent_provider_group === limitKey).length;
        const runningLoops = [...this.runningLoops.values()].filter((session) => session.agent_provider_group === limitKey).length;
        const orphaned = [...this.liveOrphanClaims.values()].filter((session) => session.agent_provider_group === limitKey).length;
        if (runningIssues + runningLoops + orphaned >= provider.max_concurrent) continue;
      }
      await this.dispatchScheduledLoop(config, loop, recentEvents);
      if (capacity.remaining !== null) capacity.remaining -= 1;
    }
  }

  private async dispatchScheduledLoop(
    config: WorkflowConfig,
    loop: ScheduledLoopConfig,
    recentEvents: ReturnType<EpisodeStore['list']>,
  ): Promise<void> {
    const provider = config.agents.providers[loop.provider ?? config.agents.default];
    if (!provider) throw new SymphonyConfigError(`scheduled loop ${loop.id} references an unknown provider`);
    if (!(await this.hasStorageCapacity(config))) return;
    const controller = new AbortController();
    let cancelAgent: ((reason: string) => Promise<void>) | null = null;
    const workspacePath = path.join(config.workspace.root, '_loops', loop.id);
    this.appendEpisodeEvent(config, `loop-${loop.id}`, 'loop.triggered', {
      loop_id: loop.id, provider: provider.id, workspace_path: workspacePath, phase: 'preparing',
    });
    log('info', 'scheduled_loop_preparing', {
      repo_id: this.repoId ?? undefined, event: 'scheduled_loop_preparing',
      loop_id: loop.id, agent_provider: provider.id, workspace_path: workspacePath,
    });
    // Reserve capacity before asynchronous preparation. Slow hooks must not hold
    // the repository tick (and every subsequent repository) hostage.
    const done = this.prepareScheduledLoop(config, loop, recentEvents, controller.signal, cancel => { cancelAgent = cancel; })
      .catch(err => {
        this.appendEpisodeEvent(config, `loop-${loop.id}`, 'loop.failed', {
          loop_id: loop.id, reason: controller.signal.aborted ? 'preparation_cancelled' : 'preparation_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        log(controller.signal.aborted ? 'info' : 'error', 'scheduled_loop_preparation_failed', {
          repo_id: this.repoId ?? undefined, event: 'scheduled_loop_preparation_failed', loop_id: loop.id,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => { this.runningLoops.delete(loop.id); });
    this.runningLoops.set(loop.id, {
      agent_provider_group: providerLimitKey(provider),
      cancel: async reason => { controller.abort(reason); if (cancelAgent) await cancelAgent(reason); },
      done,
    });
  }

  private async prepareScheduledLoop(
    config: WorkflowConfig,
    loop: ScheduledLoopConfig,
    recentEvents: ReturnType<EpisodeStore['list']>,
    signal: AbortSignal,
    setAgentCancel: (cancel: (reason: string) => Promise<void>) => void,
  ): Promise<void> {
    const provider = config.agents.providers[loop.provider ?? config.agents.default]!;
    signal.throwIfAborted();
    const workspacePath = path.join(config.workspace.root, '_loops', loop.id);
    const lastMessagePath = path.join(workspacePath, '.symphony', 'last_message.md');
    const workspaceManager = new WorkspaceManager(config.workspace, 1);
    await fs.mkdir(workspacePath, { recursive: true });

    const issue: Issue = {
      id: `loop:${loop.id}`,
      identifier: `${config.tracker.owner}/${config.tracker.repo}#loop-${loop.id}`,
      number: null,
      title: `Scheduled loop: ${loop.id}`,
      description: loop.prompt,
      priority: null,
      state: 'scheduled',
      workflow_state: 'scheduled-loop',
      branch_name: `${normalizeBranchPrefix(config.tracker.branch_prefix)}-loop-${loop.id}`,
      url: null,
      labels: ['symphony-loop'],
      assignees: [],
      milestone: null,
      blocked_by: [],
      pull_requests: [],
      created_at: null,
      updated_at: null,
      ready_for_agent_labeled_at: null,
    };
    const symphonyContext = {
      prompt_path: '',
      workspace_path: workspacePath,
      workspace_strategy: 'durable_issue_workspace',
      agent_provider: provider.id,
      agent_provider_group: provider.provider_group,
      agent_provider_kind: provider.provider_kind,
      loop_id: loop.id,
      last_message_path: lastMessagePath,
    };
    const env: Record<string, string> = {
      SYMPHONY_REPO_ID: this.repoId ?? '',
      SYMPHONY_TRACKER_OWNER: config.tracker.owner,
      SYMPHONY_TRACKER_REPO: config.tracker.repo,
      SYMPHONY_WORKSPACE_PATH: workspacePath,
      SYMPHONY_WORKSPACE_STRATEGY: 'durable_issue_workspace',
      SYMPHONY_BRANCH_NAME: issue.branch_name ?? '',
      SYMPHONY_AGENT_PROVIDER: provider.id,
      SYMPHONY_AGENT_PROVIDER_GROUP: provider.provider_group,
      SYMPHONY_AGENT_PROVIDER_KIND: provider.provider_kind,
      SYMPHONY_LOOP_ID: loop.id,
      SYMPHONY_AGENT_MODE: 'scheduled_loop',
      SYMPHONY_LAST_MESSAGE_PATH: lastMessagePath,
    };

    await workspaceManager.prepareCheckout(workspacePath, signal);
    const hasGitRepo = await workspaceManager.hasGitRepo(workspacePath);
    if (!hasGitRepo && config.hooks.after_create) {
      const entries = await fs.readdir(workspacePath);
      if (entries.length > 0) await workspaceManager.clearWorkspaceContents(workspacePath);
      const rendered = await renderTemplate(config.hooks.after_create, { issue, symphony: symphonyContext });
      await runHookScript(rendered, workspacePath, config.hooks.timeout_ms, {
        env,
        logPath: hookLogPath(workspacePath, `loop-${loop.id}-after_create`),
        streamOutput: shouldStreamHookOutput(),
        signal,
      });
    }
    if (await workspaceManager.hasGitRepo(workspacePath)) await recoverFreshRunGitState(workspacePath);
    if (config.hooks.before_run) {
      const rendered = await renderTemplate(config.hooks.before_run, { issue, symphony: symphonyContext });
      await runHookScript(rendered, workspacePath, config.hooks.timeout_ms, {
        env,
        logPath: hookLogPath(workspacePath, `loop-${loop.id}-before_run`),
        streamOutput: shouldStreamHookOutput(),
        signal,
      });
    }

    const episodeSummary = recentEvents.map((event) => ({
      event: event.event,
      episode_id: event.episode_id,
      created_at: event.created_at,
      payload: event.payload,
    }));
    const prompt = `# Symphony Scheduled Loop: ${loop.id}

${loop.prompt}

This is one scheduled invocation. Complete one bounded pass, preserve normal repository review boundaries, and leave durable evidence of what you inspected and changed.

## Recent Symphony episode summary

The following bounded, newest-first event summary is context only. Treat repository and GitHub state as authoritative.

\`\`\`json
${JSON.stringify(episodeSummary, null, 2)}
\`\`\`
`;
    const promptPath = await workspaceManager.writePrompt(workspacePath, prompt);
    symphonyContext.prompt_path = promptPath;
    env.SYMPHONY_PROMPT_PATH = promptPath;
    const renderedCommand = await renderTemplate(provider.command, { issue, symphony: symphonyContext });

    signal.throwIfAborted();
    const agent = runAgent({
      command: renderedCommand,
      cwd: workspacePath,
      env,
      turnTimeoutMs: provider.turn_timeout_ms,
      logFields: {
        repo_id: this.repoId ?? undefined,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'scheduled_loop_started',
        loop_id: loop.id,
        agent_provider: provider.id,
      },
    });
    setAgentCancel(agent.cancel);
    await agent.exit
      .then(({ code, signal }) => {
        this.appendEpisodeEvent(config, `loop-${loop.id}`, code === 0 && !signal ? 'loop.completed' : 'loop.failed', {
          loop_id: loop.id,
          provider: provider.id,
          session_id: agent.session_id,
          exit_code: code,
          signal,
          prompt_path: promptPath,
          workspace_path: workspacePath,
        });
        log(code === 0 && !signal ? 'info' : 'error', code === 0 && !signal ? 'scheduled_loop_completed' : 'scheduled_loop_failed', {
          repo_id: this.repoId ?? undefined,
          owner: config.tracker.owner,
          repo: config.tracker.repo,
          event: code === 0 && !signal ? 'scheduled_loop_completed' : 'scheduled_loop_failed',
          loop_id: loop.id,
          exit_code: code,
          signal,
        });
      })
      .catch((err) => {
        this.appendEpisodeEvent(config, `loop-${loop.id}`, 'loop.failed', {
          loop_id: loop.id,
          provider: provider.id,
          session_id: agent.session_id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private async assessAutonomousMerge(
    config: WorkflowConfig,
    tracker: GithubIssueTrackerClient,
    pr: PullRequestRef,
    reviewState: PullRequestReviewState,
  ): Promise<AutonomousMergeResult> {
    const linkedIssueNumber = issueNumberFromPullRequestBody(pr.body) ?? reviewState.issue_number;
    const result = await assessAndMaybeMerge({
      config: config.merge,
      pull_request: pr,
      linked_issue_number: linkedIssueNumber,
      receipts: reviewState.receipts,
      github: tracker,
    });
    const inputFingerprint = fingerprint({
      head: pr.head_sha,
      base: pr.base_sha,
      policy: config.merge.policy_version ?? 'v1',
      workflow: config.workflow_sha ?? null,
      receipts: reviewState.receipts,
    });
    const decisionPayload = {
      pr_number: pr.number,
      issue_number: linkedIssueNumber,
      head_sha: pr.head_sha,
      base_sha: pr.base_sha,
      policy_version: config.merge.policy_version ?? 'v1',
      workflow_sha: config.workflow_sha ?? null,
      risk: result.decision.risk,
      required_reviews: result.decision.required_reviews,
      required_evidence: result.decision.required_evidence,
      observed_evidence: result.decision.observed_evidence,
      substantive_changed_lines: result.substantive_changed_lines,
      substantive_changed_files: result.substantive_changed_files,
      reasons: result.decision.reasons,
      merge_sha: result.merge_result?.sha ?? null,
      message: result.merge_result?.message ?? null,
    };
    const decisionFingerprint = fingerprint({ action: result.action, ...decisionPayload });
    const store = new EpisodeStore(this.storePath(config));
    try {
      const previous = store.getMergeAssessment(this.durableRepoId(config), pr.number);
      if (result.action !== 'blocked' || previous?.decision_fingerprint !== decisionFingerprint) {
        this.appendEpisodeEvent(config, `pr-${pr.number}`, `merge.${result.action}`, decisionPayload);
      }
      if (result.action === 'merged') {
        store.clearMergeAssessment(this.durableRepoId(config), pr.number);
      } else {
        store.upsertMergeAssessment({
          repo_id: this.durableRepoId(config),
          pr_number: pr.number,
          input_fingerprint: inputFingerprint,
          decision_fingerprint: decisionFingerprint,
          next_check_at: new Date(nowMs() + 5 * 60 * 1000).toISOString(),
        });
      }
    } finally {
      store.close();
    }
    log(result.action === 'merged' ? 'info' : 'debug', `autonomous_merge_${result.action}`, {
      repo_id: this.repoId ?? undefined,
      owner: config.tracker.owner,
      repo: config.tracker.repo,
      event: `autonomous_merge_${result.action}`,
      pr_number: pr.number,
      risk: result.decision.risk,
      reasons: result.decision.reasons,
      merge_sha: result.merge_result?.sha ?? undefined,
    });
    return result;
  }

  private appendEpisodeEvent(
    config: WorkflowConfig,
    episodeId: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    let store: EpisodeStore | null = null;
    try {
      store = new EpisodeStore(path.join(config.workspace.root, '.symphony', 'episodes.sqlite'));
      const input = {
        repo_id: this.repoId ?? `${config.tracker.owner}/${config.tracker.repo}`,
        episode_id: episodeId,
        event,
        payload,
      };
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
      const agentTerminal = event === 'agent.completed' || event === 'agent.failed';
      const workflowTerminal = ['workflow.retry_scheduled', 'workflow.paused', 'workflow.completed', 'workflow.failed', 'workflow.cancelled'].includes(event);
      if (sessionId && (agentTerminal || workflowTerminal)) {
        store.appendOnce(input, `${episodeId}:${sessionId}:${agentTerminal ? 'agent-terminal' : 'workflow-terminal'}`);
      } else {
        store.append(input);
      }
    } catch (err) {
      log('warn', 'episode_event_write_failed', {
        repo_id: this.repoId ?? undefined,
        owner: config.tracker.owner,
        repo: config.tracker.repo,
        event: 'episode_event_write_failed',
        episode_id: episodeId,
        episode_event: event,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      store?.close();
    }
  }

  private async recordLocalValidation(config: WorkflowConfig, issue: Issue, pr: PullRequestRef, workspacePath: string): Promise<void> {
    const command = config.merge.validation_command;
    if (!command) throw new Error('Review-free automatic merging requires a local validation command');
    const previous = await this.readPullRequestReviewState(config, pr.number);
    const state: PullRequestReviewState = {
      version: 1, pr_number: pr.number,
      issue_number: issueNumberFromPullRequestBody(pr.body) ?? issue.number ?? null,
      head_ref: pr.head_ref, head_sha: pr.head_sha, base_ref: pr.base_ref, base_sha: pr.base_sha,
      verdict: 'unavailable', reason: 'Local validation is running.', reviewed_at: new Date().toISOString(),
      auto_fix_iterations: previous?.auto_fix_iterations ?? 0, receipts: previous?.receipts ?? [],
      last_review_comment_id: previous?.last_review_comment_id ?? null,
    };
    // Invalidate an older success before a rerun; failure or interruption must not leave it mergeable.
    await this.writePullRequestReviewState(config, state);
    const run = await readRunState(workspacePath);
    const logPath = path.join(run?.session_artifact_dir ?? path.join(workspacePath, '.symphony'), 'local-validation.log');
    const evidence = await validateLocalPullRequest({
      workspacePath, pullRequest: pr, command, timeoutMs: config.hooks.timeout_ms,
      logPath, signal: this.shutdownController.signal,
    });
    const receipt: VerificationReceipt = {
      receipt_id: randomUUID(), verifier: 'local-validation', verdict: 'pass',
      head_sha: pr.head_sha!, base_sha: pr.base_sha!, evidence: [evidence],
      verified_at: new Date().toISOString(), policy_version: config.merge.policy_version ?? 'v1',
      workflow_sha: config.workflow_sha, reviewer: null,
      author_execution_id: run?.agent_thread_id ?? run?.session_id ?? null,
    };
    state.verdict = 'pass';
    state.reason = evidence.summary;
    state.reviewed_at = receipt.verified_at;
    state.receipts = upsertVerificationReceipt(state.receipts, receipt);
    await this.writePullRequestReviewState(config, state);
    this.appendEpisodeEvent(config, `pr-${pr.number}`, 'verification.received', {
      pr_number: pr.number, issue_number: state.issue_number, receipt,
    });
  }

  private async createVerificationReceipt(
    config: WorkflowConfig,
    pr: PullRequestRef,
    workspacePath: string,
    verdict: VerificationReceipt['verdict'],
    reason: string,
    reviewResult: StructuredReviewResult | null,
  ): Promise<VerificationReceipt> {
    const runState = await readRunState(workspacePath).catch(() => null);
    return {
      receipt_id: randomUUID(),
      verifier: reviewResult?.reviewer?.lens ?? 'post-run-review',
      verdict: pr.head_sha && pr.base_sha ? verdict : 'unavailable',
      head_sha: pr.head_sha ?? '',
      base_sha: pr.base_sha ?? '',
      evidence: reviewResult?.evidence.length
        ? reviewResult.evidence
        : [{ kind: 'review', summary: reason, command: null, artifact: null }],
      verified_at: new Date().toISOString(),
      policy_version: config.merge.policy_version ?? 'v1',
      workflow_sha: config.workflow_sha,
      reviewer: reviewResult?.reviewer ?? {
        execution_id: randomUUID(),
        provider: null,
        model: null,
        lens: 'post-run-review',
      },
      author_execution_id: runState?.agent_thread_id ?? runState?.session_id ?? null,
    };
  }

  private async handlePassingPullRequestReview(
    config: WorkflowConfig,
    issue: Issue,
    pr: PullRequestRef,
    workspacePath: string,
    reviewResult: StructuredReviewResult,
  ): Promise<boolean> {
    const previousState = await this.readPullRequestReviewState(config, pr.number).catch(() => null);
    const runState = await readRunState(workspacePath).catch(() => null);
    const receipt = await this.createVerificationReceipt(config, pr, workspacePath, 'pass', reviewResult.summary, reviewResult);
    const reviewedAt = receipt.verified_at;
    const nextState: PullRequestReviewState = {
      version: 1,
      pr_number: pr.number,
      issue_number: issue.number ?? previousState?.issue_number ?? null,
      head_ref: pr.head_ref,
      head_sha: pr.head_sha,
      base_ref: pr.base_ref || 'main',
      base_sha: pr.base_sha,
      verdict: 'pass',
      auto_fix_iterations: previousState?.auto_fix_iterations ?? reviewAutoFixIteration(pr.labels),
      reviewed_at: reviewedAt,
      reason: reviewResult.summary,
      receipts: upsertVerificationReceipt(previousState?.receipts ?? [], receipt),
      last_review_comment_id: runState?.last_seen_pr_review_comment_id ?? previousState?.last_review_comment_id ?? null,
    };
    await this.writePullRequestReviewState(config, nextState);
    this.completeReviewExecution(config, pr, receipt, 'pass');

    const requiresAnotherReview = config.merge.enabled && freshPassingReceiptCount(config, pr, nextState) < requiredPassingReviews(config.merge);
    let queuedForAnotherRun = requiresAnotherReview;

    await this.applyLabels(config, pr.number, {
      add: requiresAnotherReview ? [LABEL_REVIEW_PASSED, LABEL_READY] : [LABEL_REVIEW_PASSED, LABEL_READY_FOR_HUMAN],
      remove: [
        LABEL_REVIEW_BLOCKING,
        'symphony-review:error',
        'symphony-review:unavailable',
        requiresAnotherReview ? LABEL_READY_FOR_HUMAN : LABEL_READY,
        LABEL_RUNNING,
        ...pr.labels.filter(isReviewAutoFixLabel),
      ],
    });

    this.appendEpisodeEvent(config, `pr-${pr.number}`, 'verification.received', {
      pr_number: pr.number,
      issue_number: nextState.issue_number,
      receipt,
      receipt_count: freshPassingReceiptCount(config, pr, nextState),
      requires_another_review: requiresAnotherReview,
    });

    if (config.merge.enabled && !requiresAnotherReview) {
      const latestPr = await new GithubIssueTrackerClient(config.tracker).fetchPullRequest(pr.number).catch(() => pr);
      if (latestPr) {
        const mergeResult = await this.assessAutonomousMerge(config, new GithubIssueTrackerClient(config.tracker), latestPr, nextState).catch((err) => {
          log('warn', 'autonomous_merge_assessment_failed', {
            ...getIssueLogFields(config, issue, this.repoId),
            event: 'autonomous_merge_assessment_failed',
            pr_number: pr.number,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        const missingEvidence = mergeResult?.decision.reasons.filter((entry) => entry.startsWith('required verification evidence is missing:')) ?? [];
        if (mergeResult?.action === 'blocked' && missingEvidence.length > 0) {
          const previousIteration = nextState.auto_fix_iterations;
          const canRemediate = config.review.auto_fix_review_comments && previousIteration < config.review.number_of_auto_fix_iterations;
          if (canRemediate) {
            const nextIteration = previousIteration + 1;
            nextState.auto_fix_iterations = nextIteration;
            await this.writePullRequestReviewState(config, nextState);
            await this.applyLabels(config, pr.number, {
              add: [LABEL_READY, `${LABEL_REVIEW_AUTO_FIX_PREFIX}${nextIteration}`],
              remove: [LABEL_READY_FOR_HUMAN, LABEL_RUNNING],
            });
            await this.updateLifecycleState(workspacePath, {
              add: [LABEL_READY, `${LABEL_REVIEW_AUTO_FIX_PREFIX}${nextIteration}`],
              remove: [LABEL_READY_FOR_HUMAN, LABEL_RUNNING],
              workflowState: LABEL_READY,
            });
            await this.upsertStatus(
              config,
              issue,
              await this.mustReadRunState(workspacePath),
              `Code review passed, but merge evidence is incomplete. Symphony queued evidence remediation ${nextIteration}/${config.review.number_of_auto_fix_iterations}: ${missingEvidence.join('; ')}`,
            );
            queuedForAnotherRun = true;
          }
        }
      }
    }
    return queuedForAnotherRun;
  }

  private async handleBlockingPullRequestReview(
    config: WorkflowConfig,
    issue: Issue,
    pr: PullRequestRef,
    workspacePath: string,
    reviewResult: StructuredReviewResult,
  ): Promise<void> {
    const previousState = await this.readPullRequestReviewState(config, pr.number).catch(() => null);
    const runState = await readRunState(workspacePath).catch(() => null);
    const previousIteration = Math.max(previousState?.auto_fix_iterations ?? 0, reviewAutoFixIteration(pr.labels));
    const sameHeadAlreadyBlocked = previousState?.verdict === 'block' && pullRequestHeadMatchesState(pr, previousState);
    const needsHuman = reviewNeedsHuman(reviewResult);
    const canAutoFix =
      config.review.auto_fix_review_comments &&
      !needsHuman &&
      !sameHeadAlreadyBlocked &&
      previousIteration < config.review.number_of_auto_fix_iterations;
    const nextIteration = canAutoFix ? previousIteration + 1 : previousIteration;
    const autoFixLabel = `${LABEL_REVIEW_AUTO_FIX_PREFIX}${nextIteration}`;
    const receipt = await this.createVerificationReceipt(config, pr, workspacePath, 'block', reviewResult.summary, reviewResult);
    const reviewedAt = receipt.verified_at;

    await this.writePullRequestReviewState(config, {
      version: 1,
      pr_number: pr.number,
      issue_number: issue.number ?? previousState?.issue_number ?? null,
      head_ref: pr.head_ref,
      head_sha: pr.head_sha,
      base_ref: pr.base_ref || 'main',
      base_sha: pr.base_sha,
      verdict: 'block',
      auto_fix_iterations: nextIteration,
      reviewed_at: reviewedAt,
      reason: reviewResult.summary,
      receipts: upsertVerificationReceipt(previousState?.receipts ?? [], receipt),
      last_review_comment_id: runState?.last_seen_pr_review_comment_id ?? previousState?.last_review_comment_id ?? null,
    });
    this.completeReviewExecution(config, pr, receipt, 'block');
    this.appendEpisodeEvent(config, `pr-${pr.number}`, 'verification.received', {
      pr_number: pr.number,
      issue_number: issue.number ?? previousState?.issue_number ?? null,
      receipt,
    });

    await this.applyLabels(config, pr.number, {
      add: canAutoFix ? [LABEL_REVIEW_BLOCKING, LABEL_READY, autoFixLabel] : [LABEL_REVIEW_BLOCKING, LABEL_READY_FOR_HUMAN],
      remove: canAutoFix
        ? [LABEL_REVIEW_PASSED, LABEL_READY_FOR_HUMAN, LABEL_RUNNING, 'symphony-review:error', 'symphony-review:unavailable']
        : [LABEL_REVIEW_PASSED, LABEL_READY, LABEL_RUNNING, 'symphony-review:error', 'symphony-review:unavailable'],
    });

    if (issue.number && issue.number !== pr.number) {
      await this.applyLabels(config, issue.number, { add: [LABEL_READY_FOR_HUMAN], remove: [LABEL_READY, LABEL_RUNNING] }).catch(() => {});
    }

    await this.updateLifecycleState(workspacePath, {
      add:
        issue.number === pr.number
          ? canAutoFix
            ? [LABEL_REVIEW_BLOCKING, LABEL_READY, autoFixLabel]
            : [LABEL_REVIEW_BLOCKING, LABEL_READY_FOR_HUMAN]
          : [LABEL_READY_FOR_HUMAN],
      remove:
        issue.number === pr.number
          ? canAutoFix
            ? [LABEL_REVIEW_PASSED, LABEL_READY_FOR_HUMAN, LABEL_RUNNING]
            : [LABEL_REVIEW_PASSED, LABEL_READY, LABEL_RUNNING]
          : [LABEL_READY, LABEL_RUNNING],
      workflowState: issue.number === pr.number && canAutoFix ? LABEL_READY : LABEL_READY_FOR_HUMAN,
    });

    let status: string;
    if (needsHuman) {
      status = `Post-run review found an ambiguous issue on PR #${pr.number}. Symphony is waiting for human input instead of guessing.`;
    } else if (canAutoFix) {
      status = `Post-run review found blocking issues on PR #${pr.number}. Symphony queued auto-fix iteration ${nextIteration}/${config.review.number_of_auto_fix_iterations}.`;
    } else if (sameHeadAlreadyBlocked) {
      status = `Post-run review found blocking issues on PR #${pr.number} again, but the PR head did not change since the previous blocking review. Symphony is waiting for human review instead of looping.`;
    } else {
      status = `Post-run review found blocking issues on PR #${pr.number}. Auto-fix is ${config.review.auto_fix_review_comments ? 'exhausted' : 'disabled'}, so the PR is waiting for human review.`;
    }

    await this.upsertStatus(config, issue, await this.mustReadRunState(workspacePath), `${status} (${reviewResult.summary})`);
  }

  private async recordNonPassingVerificationReceipt(
    config: WorkflowConfig,
    issue: Issue,
    pr: PullRequestRef,
    workspacePath: string,
    verdict: 'error' | 'unavailable',
    reason: string,
    reviewResult: StructuredReviewResult | null = null,
  ): Promise<void> {
    const previousState = await this.readPullRequestReviewState(config, pr.number).catch(() => null);
    const runState = await readRunState(workspacePath).catch(() => null);
    const receipt = await this.createVerificationReceipt(config, pr, workspacePath, verdict, reason, reviewResult);
    const reviewedAt = receipt.verified_at;
    await this.writePullRequestReviewState(config, {
      version: 1,
      pr_number: pr.number,
      issue_number: issue.number ?? previousState?.issue_number ?? null,
      head_ref: pr.head_ref,
      head_sha: pr.head_sha,
      base_ref: pr.base_ref || 'main',
      base_sha: pr.base_sha,
      verdict,
      auto_fix_iterations: previousState?.auto_fix_iterations ?? reviewAutoFixIteration(pr.labels),
      reviewed_at: reviewedAt,
      reason,
      receipts: upsertVerificationReceipt(previousState?.receipts ?? [], receipt),
      last_review_comment_id: runState?.last_seen_pr_review_comment_id ?? previousState?.last_review_comment_id ?? null,
    });
    await this.applyLabels(config, pr.number, {
      add: [`symphony-review:${verdict}`],
      remove: [LABEL_REVIEW_PASSED, LABEL_REVIEW_BLOCKING],
    }).catch(() => {});
    this.completeReviewExecution(config, pr, receipt, verdict);
    this.appendEpisodeEvent(config, `pr-${pr.number}`, 'verification.received', {
      pr_number: pr.number,
      issue_number: issue.number ?? previousState?.issue_number ?? null,
      receipt,
    });
  }

  private async readPullRequestReviewState(config: WorkflowConfig, prNumber: number): Promise<PullRequestReviewState | null> {
    const client = new GithubIssueTrackerClient(config.tracker);
    const comments = await client.listIssueComments(prNumber);
    for (const comment of comments) {
      const state = parsePullRequestReviewStateComment(comment.body);
      if (state) return state;
    }
    return null;
  }

  private completeReviewExecution(config: WorkflowConfig, pr: PullRequestRef, receipt: VerificationReceipt, status: string): void {
    const lens = receipt.reviewer?.lens ?? receipt.verifier;
    const store = new EpisodeStore(this.storePath(config));
    try {
      store.completeReviewClaim(this.durableRepoId(config), reviewExecutionKey(config, pr, lens), status);
    } finally {
      store.close();
    }
  }

  private async writePullRequestReviewState(config: WorkflowConfig, state: PullRequestReviewState): Promise<void> {
    const client = new GithubIssueTrackerClient(config.tracker);
    await client.upsertStatusComment(state.pr_number, REVIEW_STATE_MARKER, formatPullRequestReviewStateComment(state));
  }

  private async readPullRequestFeedbackState(config: WorkflowConfig, prNumber: number): Promise<PullRequestFeedbackState | null> {
    const client = new GithubIssueTrackerClient(config.tracker);
    const comments = await client.listIssueComments(prNumber);
    for (const comment of comments) {
      const state = parsePullRequestFeedbackStateComment(comment.body);
      if (state) return state;
    }
    return null;
  }

  private async writePullRequestFeedbackState(config: WorkflowConfig, state: PullRequestFeedbackState): Promise<void> {
    const client = new GithubIssueTrackerClient(config.tracker);
    await client.upsertStatusComment(state.pr_number, PR_FEEDBACK_STATE_MARKER, formatPullRequestFeedbackStateComment(state));
  }

  private async markPullRequestFeedbackAddressed(config: WorkflowConfig, prNumber: number): Promise<void> {
    const state = await this.readPullRequestFeedbackState(config, prNumber);
    if (!state?.pending) return;
    await this.writePullRequestFeedbackState(config, {
      ...state,
      pending: false,
      updated_at: new Date().toISOString(),
    });
  }

  private externalNonBlockingReviewResult(state: PullRequestFeedbackState): StructuredReviewResult {
    const priorities = state.priorities.length > 0 ? state.priorities.map((priority) => priority.toUpperCase()).join(', ') : 'configured non-blocking';
    const executionId = `github-feedback-${state.last_review_comment_id ?? state.last_issue_comment_id ?? state.feedback_round}`;
    const summary = `External PR review contains only non-blocking feedback (${priorities}); follow-up handling completed without changing the reviewed head.`;
    return {
      verdict: 'pass',
      summary,
      findings: [{ disposition: 'nit', severity: priorities, summary, file: null, line: null }],
      evidence: [{ kind: 'review', summary, command: null, artifact: null }],
      reviewer: {
        execution_id: executionId,
        provider: 'github-pr-review',
        model: null,
        lens: 'external-review-policy',
      },
      structured: true,
    };
  }

  private externalCodexApprovalResult(reaction: IssueReaction): StructuredReviewResult {
    const summary = 'Codex completed review of the current PR head without findings.';
    return {
      verdict: 'pass',
      summary,
      findings: [],
      evidence: [{ kind: 'review', summary, command: null, artifact: null }],
      reviewer: {
        execution_id: `github-codex-reaction-${reaction.id}`,
        provider: 'github-codex',
        model: null,
        lens: 'codex-review',
      },
      structured: true,
    };
  }

  private async writePullRequestReviewPrompt(
    config: WorkflowConfig,
    workspacePath: string,
    issue: Issue,
    pr: PullRequestRef,
    preferredLens?: string,
  ): Promise<{ path: string; lens: string }> {
    const runState = await readRunState(workspacePath).catch(() => null);
    const symphonyDir = runState?.session_artifact_dir ?? path.join(workspacePath, '.symphony');
    await fs.mkdir(symphonyDir, { recursive: true });
    const reviewPromptPath = path.join(symphonyDir, 'review_prompt.md');
    const baseRef = pr.base_ref || 'main';
    const previousState = await this.readPullRequestReviewState(config, pr.number).catch(() => null);
    const priorReviewExecutions = new Set(
      (previousState?.receipts ?? [])
        .filter((receipt) => receipt.head_sha === pr.head_sha && receipt.base_sha === pr.base_sha && receipt.reviewer?.execution_id)
        .map((receipt) => receipt.reviewer!.execution_id),
    ).size;
    const lens = preferredLens ?? config.review.lenses[priorReviewExecutions % config.review.lenses.length] ?? 'staff-engineer';
    const prompt = `You are performing Symphony's post-run review for PR #${pr.number}${pr.url ? ` (${pr.url})` : ''}.

Review from the perspective of a staff engineer. Prioritize actionable issues that matter before merge: correctness bugs, regressions, incomplete requirements, missing or weak tests, maintainability risks, code quality gaps, security or data-safety issues, and avoidable architectural complexity.

Review lens: \`${lens}\`. Apply this lens as an additional focus while still reporting any merge-blocking correctness or safety issue you find.

Preferred flow:
- If this repository has the \`/code-review\` skill installed, use it to review \`origin/${baseRef}...HEAD\`.
- If \`/code-review\` is unavailable or cannot run in this repo, fall back to a manual review of \`origin/${baseRef}...HEAD\`.
- Treat the issue and PR body as the spec source when no separate spec is available.
- Keep findings concise, ranked by severity, and cite file/line references when possible.

Issue:
- Identifier: ${issue.identifier}
- Title: ${issue.title}
- URL: ${issue.url ?? '(none)'}

Pull request:
- PR: #${pr.number}
- URL: ${pr.url ?? '(none)'}
- Head branch: ${pr.head_ref}
- Head SHA: ${pr.head_sha ?? '(unknown)'}
- Base branch: ${baseRef}

Final response requirements:
- Include exactly one single-line JSON result using this schema:
  \`SYMPHONY_REVIEW_RESULT: {"verdict":"pass|block|retry","summary":"...","findings":[{"disposition":"actionable|nit|ambiguous","severity":"critical|high|medium|low|nit","summary":"...","file":"path or null","line":123}]}.\`
- Use disposition \`actionable\` when an agent can make a clear bounded fix, \`nit\` for non-blocking polish, and \`ambiguous\` only when a real product, architecture, security, data-loss, cost, or irreversible decision is required.
- Use verdict \`retry\` only when review could not complete because of a transient tool, provider, or environment failure.
- Emit exactly one \`SYMPHONY_REVIEW_RESULT\` payload.
- Use verdict \`block\` only when there are actionable blockers Symphony should send back to an agent or human before merge.
- Use verdict \`pass\` when there are no blocking findings. Non-blocking notes are fine, but keep them clearly labeled.
`;
    await fs.writeFile(reviewPromptPath, prompt, 'utf8');
    if (runState?.session_artifact_dir) {
      await fs.writeFile(path.join(workspacePath, '.symphony', 'review_prompt.md'), prompt, 'utf8');
    }
    return { path: reviewPromptPath, lens };
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
            : 'main',
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

  private async completeWorkflowState(workspacePath: string): Promise<void> {
    await updateRunState(workspacePath, (cur) => cur ? {
      ...cur,
      status: 'completed',
      finalization_step: 'effects-applied',
      workflow_outcome: 'completed',
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } : null);
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
            workflow_outcome: 'paused',
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
    const state = await readRunState(workspacePath);
    const marker = `<!-- symphony-plan:${state?.session_id ?? issue.id} -->`;
    const body = [
      marker,
      '## Symphony Technical Specification',
      '',
      lastMessage || `The planning agent completed successfully, but no final message was captured. Review the workspace artifacts in \`${workspacePath}\`.`,
    ].join('\n');
    await new GithubIssueTrackerClient(config.tracker).upsertStatusComment(issue.number, marker, body);
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

  private async scheduleRetry(config: WorkflowConfig, issue: Issue, attempt: number, reason: string, workspacePath?: string, modeOverride?: AgentMode): Promise<void> {
    const retryState = workspacePath ? await readRunState(workspacePath) : null;
    const retrySessionId = retryState?.session_id ?? null;
    if (retryState?.agent_mode === 'pr-review' && retryState.finalization_context?.review_pr?.review_key) {
      const reviewStore = new EpisodeStore(this.storePath(config));
      try {
        reviewStore.completeReviewClaim(this.durableRepoId(config), retryState.finalization_context.review_pr.review_key, 'error');
      } finally {
        reviewStore.close();
      }
    }
    const nextAttempt = attempt + 1;
    if (config.agent.max_attempts !== null && nextAttempt > config.agent.max_attempts) {
      this.deleteDurableRetry(config, issue.id);
      this.appendEpisodeEvent(config, `${issue.identifier}:attempt:${attempt}`, 'workflow.failed', {
        issue_number: issue.number,
        issue_identifier: issue.identifier,
        attempt,
        max_attempts: config.agent.max_attempts,
        reason,
        session_id: retrySessionId,
      });
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
        await this.applyLabels(config, issue.number, {
          add: [LABEL_FAILED],
          remove: [LABEL_READY, LABEL_RUNNING, LABEL_NEEDS_INFO],
        });
        if (workspacePath) {
          await updateRunState(workspacePath, (cur) => cur ? {
            ...cur,
            status: 'failed',
            workflow_outcome: 'failed',
            retry_reason: reason,
            labels: [...new Set([...(cur.labels ?? []).filter((label) => ![LABEL_READY, LABEL_RUNNING, LABEL_NEEDS_INFO].includes(label)), LABEL_FAILED])],
            workflow_state: LABEL_FAILED,
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } : null);
        }
        const marker = `<!-- symphony-failure:${issue.identifier} -->`;
        const attempts = config.agent.max_attempts;
        const body = [
          marker,
          '### Symphony Failure',
          '',
          `Autonomous dispatch failed after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
          '',
          `Reason: ${reason}`,
          workspacePath ? `Workspace: \`${workspacePath}\`` : null,
          '',
          'Fix the operational failure, remove `symphony-failed`, and add `ready-for-agent` to retry.',
        ].filter((line): line is string => line !== null).join('\n');
        await new GithubIssueTrackerClient(config.tracker).upsertStatusComment(issue.number, marker, body);
      }
      return;
    }
    const delayMs = computeBackoffMs(nextAttempt, config.agent.max_retry_backoff_ms);
    const nextAt = nowMs() + delayMs;

    if (issue.number) {
      await this.applyLabels(config, issue.number, { remove: [LABEL_READY, LABEL_RUNNING] }).catch(() => {});
    }
    if (workspacePath) {
      await this.updateLifecycleState(workspacePath, { remove: [LABEL_READY, LABEL_RUNNING], workflowState: 'retry-wait' });
    }

    this.retries.set(issue.id, {
      attempt: nextAttempt,
      next_run_at_ms: nextAt,
      issue_number: issue.number ?? -1,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      reason,
      workspace_path: workspacePath ?? null,
      mode: modeOverride ?? ((workspacePath ? await readRunState(workspacePath) : null)?.agent_mode ?? (issue.labels.includes(GROOMING_LABEL) ? 'grooming' : 'autonomous')) as AgentMode,
    });
    const retry = this.retries.get(issue.id)!;
    const store = new EpisodeStore(this.storePath(config));
    try {
      store.upsertRetry({
        repo_id: this.durableRepoId(config),
        issue_id: issue.id,
        issue_number: issue.number ?? -1,
        issue_identifier: issue.identifier,
        attempt: nextAttempt,
        reason,
        next_run_at: new Date(nextAt).toISOString(),
        workspace_path: workspacePath ?? null,
        mode: retry.mode,
      });
    } finally {
      store.close();
    }
    if (workspacePath) {
      await updateRunState(workspacePath, (cur) => cur ? {
        ...cur,
        status: 'retry-wait',
        workflow_outcome: 'retry-scheduled',
        retry_reason: reason,
        retry_not_before: new Date(nextAt).toISOString(),
        worker_pid: null,
        updated_at: new Date().toISOString(),
      } : null);
    }
    this.appendEpisodeEvent(config, `${issue.identifier}:attempt:${attempt}`, 'workflow.retry_scheduled', {
      issue_number: issue.number,
      issue_identifier: issue.identifier,
      attempt: nextAttempt,
      delay_ms: delayMs,
      next_run_at: new Date(nextAt).toISOString(),
      reason,
      session_id: retrySessionId,
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
        const now = nowMs();
        const backoffUntil = this.providerUsageLimitBackoffUntil.get(limitKey);
        if (backoffUntil !== undefined && now < backoffUntil) {
          this.providerUsageLimitCheckBlocked.add(limitKey);
          return;
        }
        const result = await this.checkUsageLimitCommand(command, provider);
        if (result.decision === 'unknown') {
          log('warn', 'provider_usage_limit_check_unknown', {
            repo_id: this.repoId ?? undefined,
            event: 'provider_usage_limit_check_unknown',
            agent_provider: provider.id,
            agent_provider_group: limitKey,
            check_command: command,
          });
        }
        if (result.decision === 'blocked') {
          if (typeof result.resetsAtMs === 'number' && Number.isFinite(result.resetsAtMs) && result.resetsAtMs > now) {
            this.providerUsageLimitBackoffUntil.set(limitKey, result.resetsAtMs);
            const resetInMs = result.resetsAtMs - now;
            const resetDate = new Date(result.resetsAtMs);
            log('info', 'provider_usage_limit_check_backoff_set', {
              repo_id: this.repoId ?? undefined,
              event: 'provider_usage_limit_check_backoff_set',
              agent_provider: provider.id,
              agent_provider_group: limitKey,
              check_command: command,
              reset_at_ms: result.resetsAtMs,
              reset_in_ms: resetInMs,
              reset_in: humanizeDurationMs(resetInMs),
              reset_at: resetDate.toISOString(),
              reset_at_local: resetDate.toLocaleString(),
            });
          }
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

  private async checkUsageLimitCommand(command: string, provider: AgentProviderConfig): Promise<UsageLimitCheckResult> {
    const result = await this.runUsageLimitCommand(command, provider);

    if (this.isCodexBarUsageCheckCommand(command)) {
      const parsed = this.parseCodexBarUsageLimit(command, result.stdout);
      if (parsed !== null) return parsed;
      return { decision: 'blocked' };
    }

    if (result.code === 0) return { decision: 'allowed' };
    if (result.code === 2) return { decision: 'unknown' };
    return { decision: 'blocked' };
  }

  private async runUsageLimitCommand(command: string, provider: AgentProviderConfig): Promise<UsageLimitCommandResult> {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const limitKey = providerLimitKey(provider);

      const finalize = (value: UsageLimitCommandResult) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const child = spawn(command, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });

      const timeout = setTimeout(() => {
        // Process may have already exited by the time kill() is called; that is harmless.
        try {
          child.kill('SIGTERM');
        } catch {
          // already exited
        }
        log('warn', 'provider_usage_limit_check_timeout', {
          repo_id: this.repoId ?? undefined,
          event: 'provider_usage_limit_check_timeout',
          agent_provider: provider.id,
          agent_provider_group: limitKey,
          check_command: command,
        });
        finalize({ code: null, stdout, stderr });
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
        finalize({ code: null, stdout, stderr: `${stderr}\n${err.message}` });
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        finalize({ code: code ?? null, stdout, stderr });
      });
    });
  }

  private isCodexBarUsageCheckCommand(command: string): boolean {
    return (
      /(^|[\s;|&()])codexbar\b/.test(command) &&
      /--provider(?:=|\s+)/.test(command) &&
      /--format(?:=|\s+)json\b/.test(command)
    );
  }

  private parseCodexBarUsageLimit(command: string, output: string): CodexBarUsageParseResult | null {
    const providerMatch = command.match(/--provider(?:=|\s+)(?:'([^']+)'|"([^"]+)"|([^\s"']+))/);
    const requestedProvider = providerMatch ? providerMatch[1] || providerMatch[2] || providerMatch[3] : null;
    let payload: unknown;

    try {
      payload = JSON.parse(output);
    } catch {
      return null;
    }

    const entries = Array.isArray(payload) ? payload : [payload];
    const selectedEntries =
      !requestedProvider || requestedProvider === 'all' || requestedProvider === 'both'
        ? entries
        : entries.filter((entry) => entry && typeof entry === 'object' && (entry as { provider?: unknown }).provider === requestedProvider);

    const samples = selectedEntries.length > 0 ? selectedEntries : entries;
    const usedPercents: number[] = [];
    const resetTimestamps: number[] = [];
    for (const entry of samples) {
      const usage = (entry as { usage?: { primary?: unknown; secondary?: unknown; tertiary?: unknown } }).usage;
      if (!usage || typeof usage !== 'object') continue;
      const windows = ['primary', 'secondary', 'tertiary'].map((key) => usage[key as 'primary' | 'secondary' | 'tertiary']);
      for (const window of windows) {
        if (!window || typeof window !== 'object') continue;
        const percent = Number((window as { usedPercent?: unknown }).usedPercent);
        if (Number.isFinite(percent)) usedPercents.push(percent);

        if (percent >= CODEXBAR_USAGE_LIMIT_THRESHOLD && Number.isFinite(percent)) {
          const rawResetAt = (window as { resetsAt?: unknown }).resetsAt;
          let resetAtMs = Number.NaN;
          if (typeof rawResetAt === 'string') resetAtMs = Date.parse(rawResetAt);
          if (typeof rawResetAt === 'number') {
            resetAtMs = rawResetAt > 1e12 ? rawResetAt : rawResetAt * 1000;
          }
          if (Number.isFinite(resetAtMs)) resetTimestamps.push(resetAtMs);
        }
      }
    }

    if (usedPercents.length === 0) return null;
    const blocked = usedPercents.some((percent) => percent >= CODEXBAR_USAGE_LIMIT_THRESHOLD);
    if (!blocked) return { decision: 'allowed' };
    const resetsAtMs = resetTimestamps.length > 0 ? Math.min(...resetTimestamps) : undefined;
    return { decision: 'blocked', resetsAtMs };
  }

  private dispatchBlockReason(
    config: WorkflowConfig,
    issue: Issue,
    provider: AgentProviderConfig,
    capacity: DispatchCapacity,
  ): DispatchBlockReason | null {
    const blocked = (reason: DispatchBlockReason): DispatchBlockReason => {
      log('info', 'dispatch_capacity_blocked', {
        ...getIssueLogFields(config, issue, this.repoId),
        reason,
        agent_provider: provider.id,
        active_count: this.getRunningCount(),
        capacity_remaining: capacity.remaining,
      });
      return reason;
    };
    if (capacity.remaining !== null && capacity.remaining <= 0) return blocked('global_capacity');
    const maxConcurrentAgents = this.maxConcurrentAgentsOverride ?? config.agent.max_concurrent_agents;
    if (this.getRunningCount() >= maxConcurrentAgents) return blocked('global_capacity');
    const byState = config.agent.max_concurrent_agents_by_state;
    if (byState) {
      const limit = byState[issue.state];
      if (typeof limit === 'number') {
        const runningInState = [...this.running.values()].filter((s) => s.issue_state === issue.state).length;
        const orphanedInState = [...this.liveOrphanClaims.values()].filter((s) => s.issue_state === issue.state).length;
        if (runningInState + orphanedInState >= limit) return blocked('state_capacity');
      }
    }
    const limitKey = providerLimitKey(provider);
    const backoffUntil = this.providerUsageLimitBackoffUntil.get(limitKey);
    if (backoffUntil !== undefined && nowMs() < backoffUntil) return blocked('usage_limit');
    if (this.providerUsageLimitCheckBlocked.has(limitKey)) return blocked('usage_limit');
    if (provider.max_concurrent !== null) {
      const runningForProvider = [...this.running.values()].filter((s) => s.agent_provider_group === limitKey).length;
      const runningLoopsForProvider = [...this.runningLoops.values()].filter((s) => s.agent_provider_group === limitKey).length;
      const orphanedForProvider = [...this.liveOrphanClaims.values()].filter((s) => s.agent_provider_group === limitKey).length;
      if (runningForProvider + runningLoopsForProvider + orphanedForProvider >= provider.max_concurrent) return blocked('provider_capacity');
    }
    return null;
  }
}
