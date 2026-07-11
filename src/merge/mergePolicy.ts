import type { MergeConfig, MergeRisk } from '../workflow/types.js';

export type VerificationVerdict = 'pass' | 'block' | 'error' | 'unavailable';

export interface VerificationEvidence {
  kind: string;
  summary: string;
  command: string | null;
  artifact: string | null;
}

export interface VerificationReviewer {
  execution_id: string;
  provider: string | null;
  model: string | null;
  lens: string | null;
}

export interface VerificationReceipt {
  receipt_id: string;
  verifier: string;
  verdict: VerificationVerdict;
  head_sha: string;
  base_sha: string;
  evidence: Array<string | VerificationEvidence>;
  verified_at: string;
  policy_version?: string;
  workflow_sha?: string;
  reviewer?: VerificationReviewer | null;
  author_execution_id?: string | null;
}

export interface MergeCheckResult {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: string | null;
}

export interface MergePolicyPullRequest {
  state: string;
  is_draft: boolean;
  merge_state_status: string | null;
  head_sha: string | null;
  base_sha: string | null;
  linked_issue_number: number | null;
  labels: string[];
}

export interface MergeEligibilityDecision {
  eligible: boolean;
  risk: MergeRisk;
  required_reviews: number;
  required_evidence: string[];
  observed_evidence: string[];
  reasons: string[];
}

export interface MergeRiskInput {
  labels: string[];
  changed_paths: string[];
  target_branch: string;
  substantive_changed_lines?: number;
  substantive_changed_files?: number;
}

export interface MergeChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

const RISK_RANK: Record<MergeRisk, number> = { standard: 0, elevated: 1, prohibited: 2 };
const BLOCKING_LABELS = new Set(['blocked', 'needs-info', 'interactive', 'symphony-review:blocking']);
const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      const isDouble = glob[index + 1] === '*';
      if (isDouble) {
        const followedBySlash = glob[index + 2] === '/';
        pattern += followedBySlash ? '(?:.*/)?' : '.*';
        index += followedBySlash ? 2 : 1;
      } else {
        pattern += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${pattern}$`);
}

export function summarizeSubstantiveChanges(config: MergeConfig, files: MergeChangedFile[]): {
  substantive_changed_lines: number;
  substantive_changed_files: number;
} {
  const ignored = (config.substantive_ignored_paths ?? []).map(globToRegExp);
  const substantive = files.filter((file) => !ignored.some((matcher) => matcher.test(file.path)));
  return {
    substantive_changed_lines: substantive.reduce((total, file) => total + Math.max(0, file.additions) + Math.max(0, file.deletions), 0),
    substantive_changed_files: substantive.length,
  };
}

function ruleMatches(
  rule: MergeConfig['rules'][number],
  input: MergeRiskInput,
): boolean {
  const labels = new Set(input.labels.map((label) => label.trim().toLowerCase()));
  if (rule.any_labels.some((label) => labels.has(label))) return true;
  if (rule.target_branches.includes(input.target_branch)) return true;
  if (rule.min_changed_lines !== null && rule.min_changed_lines !== undefined) {
    if ((input.substantive_changed_lines ?? 0) >= rule.min_changed_lines) return true;
  }
  if (rule.min_changed_files !== null && rule.min_changed_files !== undefined) {
    if ((input.substantive_changed_files ?? 0) >= rule.min_changed_files) return true;
  }
  return rule.paths.some((glob) => {
    const matcher = globToRegExp(glob);
    return input.changed_paths.some((changedPath) => matcher.test(changedPath));
  });
}

export function classifyMergeRisk(
  config: MergeConfig,
  input: MergeRiskInput,
): MergeRisk {
  let risk = config.default_risk;
  for (const rule of config.rules) {
    if (ruleMatches(rule, input) && RISK_RANK[rule.risk] > RISK_RANK[risk]) risk = rule.risk;
  }
  return risk;
}

export function requiredMergeEvidence(config: MergeConfig, risk: MergeRisk, input: MergeRiskInput): string[] {
  if (risk === 'prohibited') return [];
  const required = new Set((config.required_evidence?.[risk] ?? ['review']).map((kind) => kind.trim().toLowerCase()).filter(Boolean));
  for (const rule of config.rules) {
    if (!ruleMatches(rule, input)) continue;
    for (const kind of rule.required_evidence ?? []) {
      const normalized = kind.trim().toLowerCase();
      if (normalized) required.add(normalized);
    }
  }
  return [...required].sort();
}

function evidenceKind(evidence: string | VerificationEvidence): string {
  return typeof evidence === 'string' ? 'review' : evidence.kind.trim().toLowerCase();
}

export function evaluateMergeEligibility(input: {
  config: MergeConfig;
  risk: MergeRisk;
  pull_request: MergePolicyPullRequest;
  checks: MergeCheckResult[];
  receipts: VerificationReceipt[];
  required_evidence?: string[];
}): MergeEligibilityDecision {
  const { config, risk, pull_request: pr, checks, receipts } = input;
  const requiredReviews = risk === 'elevated' ? 2 : 1;
  const requiredEvidence = [...new Set((input.required_evidence ?? ['review']).map((kind) => kind.trim().toLowerCase()).filter(Boolean))].sort();
  const reasons: string[] = [];

  if (!config.enabled) reasons.push('autonomous merge is disabled');
  if (risk === 'prohibited') reasons.push('risk is prohibited');
  if (pr.state !== 'open') reasons.push(`pull request is not open: ${pr.state}`);
  if (pr.is_draft) reasons.push('pull request is a draft');
  if (pr.merge_state_status !== 'clean') reasons.push(`pull request is not mergeable: ${pr.merge_state_status ?? 'unknown'}`);
  if (!pr.head_sha) reasons.push('head SHA is unavailable');
  if (!pr.base_sha) reasons.push('base SHA is unavailable');
  if (pr.linked_issue_number === null) reasons.push('no linked issue');

  for (const label of pr.labels.map((value) => value.trim().toLowerCase())) {
    if (BLOCKING_LABELS.has(label)) reasons.push(`blocking workflow label: ${label}`);
  }

  if (checks.length === 0) {
    reasons.push('no check results available');
  } else {
    for (const check of checks) {
      if (check.status !== 'completed' || !check.conclusion || !PASSING_CHECK_CONCLUSIONS.has(check.conclusion)) {
        reasons.push(`check is not successful: ${check.name} (${check.status}${check.conclusion ? `/${check.conclusion}` : ''})`);
      }
    }
  }

  const policyVersion = config.policy_version ?? 'v1';
  const freshPassingReceipts = receipts.filter(
    (receipt) =>
      receipt.verdict === 'pass' &&
      Boolean(pr.head_sha) &&
      Boolean(pr.base_sha) &&
      receipt.head_sha === pr.head_sha &&
      receipt.base_sha === pr.base_sha &&
      (receipt.policy_version ?? 'v1') === policyVersion &&
      (receipt.workflow_sha ?? null) === (config.workflow_sha ?? null),
  );
  const reviewReceipts = freshPassingReceipts.filter((receipt) => receipt.evidence.some((entry) => evidenceKind(entry) === 'review'));
  const independentReviews = config.require_independent_reviews
    ? new Set(
        reviewReceipts
          .filter(
            (receipt) =>
              Boolean(receipt.reviewer?.execution_id) &&
              (!receipt.author_execution_id || receipt.reviewer?.execution_id !== receipt.author_execution_id),
          )
          .map((receipt) => receipt.reviewer!.execution_id),
      )
    : new Set(reviewReceipts.map((receipt) => receipt.receipt_id));
  if (independentReviews.size < requiredReviews) {
    reasons.push(
      `requires ${requiredReviews} fresh independent passing review${requiredReviews === 1 ? '' : 's'}; found ${independentReviews.size}`,
    );
  }

  const observedEvidence = [...new Set(freshPassingReceipts.flatMap((receipt) => receipt.evidence.map(evidenceKind)).filter(Boolean))].sort();
  for (const kind of requiredEvidence) {
    if (!observedEvidence.includes(kind)) reasons.push(`required verification evidence is missing: ${kind}`);
  }

  return {
    eligible: reasons.length === 0,
    risk,
    required_reviews: requiredReviews,
    required_evidence: requiredEvidence,
    observed_evidence: observedEvidence,
    reasons,
  };
}
