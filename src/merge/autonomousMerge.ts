import type { MergePullRequestResult, PullRequestCheck, PullRequestFile, PullRequestRef } from '../github/githubClient.js';
import type { MergeConfig } from '../workflow/types.js';
import {
  classifyMergeRisk,
  evaluateMergeEligibility,
  requiredMergeEvidence,
  summarizeSubstantiveChanges,
  type MergeEligibilityDecision,
  type VerificationReceipt,
} from './mergePolicy.js';

export interface MergeGithubAdapter {
  listPullRequestFiles(number: number): Promise<string[]>;
  listPullRequestFileDetails?(number: number): Promise<PullRequestFile[]>;
  listPullRequestChecks(headSha: string): Promise<PullRequestCheck[]>;
  mergePullRequest(
    number: number,
    options: { expectedHeadSha: string; method: 'merge' | 'squash' | 'rebase' },
  ): Promise<MergePullRequestResult>;
}

export interface AutonomousMergeResult {
  action: 'blocked' | 'dry-run' | 'merged' | 'merge-rejected';
  decision: MergeEligibilityDecision;
  changed_paths: string[];
  substantive_changed_lines: number;
  substantive_changed_files: number;
  merge_result: MergePullRequestResult | null;
}

export async function assessAndMaybeMerge(input: {
  config: MergeConfig;
  pull_request: PullRequestRef;
  linked_issue_number: number | null;
  receipts: VerificationReceipt[];
  github: MergeGithubAdapter;
}): Promise<AutonomousMergeResult> {
  const { config, pull_request: pr, linked_issue_number: linkedIssueNumber, receipts, github } = input;
  const fileDetails = github.listPullRequestFileDetails ? await github.listPullRequestFileDetails(pr.number) : null;
  const changedPaths = fileDetails ? fileDetails.map((file) => file.path) : await github.listPullRequestFiles(pr.number);
  const substantive = fileDetails
    ? summarizeSubstantiveChanges(config, fileDetails)
    : { substantive_changed_lines: 0, substantive_changed_files: changedPaths.length };
  const checks = pr.head_sha ? await github.listPullRequestChecks(pr.head_sha) : [];
  const riskInput = {
    labels: pr.labels,
    changed_paths: changedPaths,
    target_branch: pr.base_ref,
    ...substantive,
  };
  const risk = classifyMergeRisk(config, riskInput);
  const decision = evaluateMergeEligibility({
    config,
    risk,
    pull_request: {
      state: pr.state,
      is_draft: pr.is_draft,
      merge_state_status: pr.merge_state_status,
      head_sha: pr.head_sha,
      base_sha: pr.base_sha,
      linked_issue_number: linkedIssueNumber,
      labels: pr.labels,
    },
    checks,
    receipts,
    required_evidence: requiredMergeEvidence(config, risk, riskInput),
  });

  const resultBase = { decision, changed_paths: changedPaths, ...substantive };
  if (!decision.eligible) return { action: 'blocked', ...resultBase, merge_result: null };
  if (config.dry_run) return { action: 'dry-run', ...resultBase, merge_result: null };
  if (!pr.head_sha) return { action: 'blocked', ...resultBase, merge_result: null };

  const mergeResult = await github.mergePullRequest(pr.number, {
    expectedHeadSha: pr.head_sha,
    method: config.method,
  });
  return {
    action: mergeResult.merged ? 'merged' : 'merge-rejected',
    ...resultBase,
    merge_result: mergeResult,
  };
}
