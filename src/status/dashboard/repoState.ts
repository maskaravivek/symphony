import type { PullRequestSummary, RepoState, TaskSummary } from '../dashboardTypes.js';
import { DashboardNotFoundError, loadLocal, type ReadModelOptions } from './context.js';
import { EpisodeReader, numberField } from './episodeReader.js';
import { collapseWithGrowingWindow, summarizeEpisodeEvent } from './episodeSummary.js';
import type { RepoLocalState } from './localState.js';
import { findRepoSource, type DashboardSources } from './sources.js';

export const RECENT_EVENTS_LIMIT = 50;
/** Raw rows read for recent_events before collapsing repeats (grown up to the cap when repeats dominate). */
const RECENT_EVENTS_RAW_LIMIT = RECENT_EVENTS_LIMIT * 5;
const RECENT_EVENTS_RAW_CAP = 2_500;
export const CLOSED_TASKS_LIMIT = 20;

function reviewLabels(labels: string[]): string[] {
  return [...new Set(labels.map((label) => label.trim().toLowerCase()).filter((label) => label.startsWith('symphony-review:')))].sort();
}

/**
 * Open PRs for a repo: GitHub's open-PR list when the cache has one, otherwise the PRs Symphony
 * knows about locally (PR review runs that are not closed). Joined with review claims, feedback
 * rounds, and the latest merge decision.
 */
export function buildPullRequests(local: RepoLocalState): PullRequestSummary[] {
  const config = local.source.config;
  if (!config) return [];
  const repoId = local.source.repo_id;
  const github = local.github?.last_refreshed_at ? local.github : null;
  const claims = new Map(local.review_claims.map((claim) => [claim.review_key, claim.status]));
  const runByNumber = new Map(local.runs.filter((run) => run.issue_number !== null).map((run) => [run.issue_number!, run]));

  const refs: Array<{ number: number; url: string | null; title: string | null; head_ref: string | null; labels: string[] }> = [];
  if (github) {
    for (const pr of github.pull_requests) {
      refs.push({ number: pr.number, url: pr.url, title: pr.title, head_ref: pr.head_ref, labels: pr.labels });
    }
  } else {
    const closedKeys = new Set(local.tasks.filter((task) => task.lifecycle === 'closed').map((task) => task.task_key));
    for (const run of local.runs) {
      const review = run.finalization_context?.review_pr;
      if (!review || refs.some((ref) => ref.number === review.pr_number)) continue;
      const issue = local.pr_to_issue.get(review.pr_number) ?? review.pr_number;
      if (closedKeys.has(`${repoId}/${issue}`)) continue;
      refs.push({ number: review.pr_number, url: review.pr_url, title: run.issue_title ?? null, head_ref: review.head_ref, labels: run.labels ?? [] });
    }
  }

  return refs
    .map((ref): PullRequestSummary => {
      const run = runByNumber.get(ref.number);
      const review = run?.finalization_context?.review_pr?.pr_number === ref.number ? run.finalization_context.review_pr : null;
      const feedback = local.feedback_events.get(ref.number);
      const merge = local.merge_events.get(ref.number);
      const issueNumber = local.pr_to_issue.get(ref.number) ?? null;
      const meta = github?.issues.get(ref.number);
      const reasons =
        merge?.event === 'merge.blocked' && Array.isArray(merge.payload.reasons)
          ? merge.payload.reasons.filter((value): value is string => typeof value === 'string')
          : [];
      return {
        repo_id: repoId,
        number: ref.number,
        url: ref.url ?? meta?.url ?? null,
        title: ref.title ?? meta?.title ?? null,
        head_ref: ref.head_ref,
        issue_number: issueNumber,
        task_key: `${repoId}/${issueNumber ?? ref.number}`,
        review_labels: reviewLabels([...ref.labels, ...(meta?.labels ?? [])]),
        review_claim_status: review?.review_key ? (claims.get(review.review_key) ?? null) : null,
        feedback_round: review?.feedback_round ?? numberField(feedback?.payload.feedback_round) ?? null,
        max_feedback_rounds: review?.max_feedback_rounds ?? numberField(feedback?.payload.max_feedback_rounds) ?? config.review.max_feedback_rounds ?? null,
        merge_blocked_reasons: reasons,
        last_merge_assessment_at: merge?.created_at ?? null,
        updated_at: meta?.updated_at ?? run?.updated_at ?? null,
      };
    })
    .sort((a, b) => b.number - a.number);
}

export function limitTasks(tasks: TaskSummary[]): TaskSummary[] {
  const open = tasks.filter((task) => task.lifecycle !== 'closed');
  const closed = tasks
    .filter((task) => task.lifecycle === 'closed')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, CLOSED_TASKS_LIMIT);
  return [...open, ...closed];
}

export async function loadRepoState(sources: DashboardSources, repoId: string, options: ReadModelOptions = {}): Promise<RepoState> {
  const repo = findRepoSource(sources, repoId);
  if (!repo) throw new DashboardNotFoundError(`unknown repo: ${repoId}`);
  const now = options.now ?? new Date();
  const local = await loadLocal(sources, repo, { ...options, now });
  const reader = EpisodeReader.open(repo.workspace_root);
  let recent;
  try {
    recent = collapseWithGrowingWindow(
      (count) => reader.listEvents({ limit: count }),
      (event) => summarizeEpisodeEvent(event, repoId, local.pr_to_issue),
      RECENT_EVENTS_LIMIT,
      RECENT_EVENTS_RAW_LIMIT,
      RECENT_EVENTS_RAW_CAP,
    ).events;
  } finally {
    reader.close();
  }
  return {
    ...local.summary,
    generated_at: now.toISOString(),
    heartbeat: local.heartbeat,
    tasks: limitTasks(local.tasks),
    slots: local.slots,
    retry_queue: local.retry_queue,
    loops: local.loops,
    pull_requests: buildPullRequests(local),
    epics: local.epics,
    recent_events: recent,
  };
}
