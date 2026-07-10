import type { MergeConfig, MergeRisk } from '../workflow/types.js';

export type VerificationVerdict = 'pass' | 'block' | 'error' | 'unavailable';

export interface VerificationReceipt {
  receipt_id: string;
  verifier: string;
  verdict: VerificationVerdict;
  head_sha: string;
  base_sha: string;
  evidence: string[];
  verified_at: string;
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
  reasons: string[];
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

function ruleMatches(
  rule: MergeConfig['rules'][number],
  input: { labels: string[]; changed_paths: string[]; target_branch: string },
): boolean {
  const labels = new Set(input.labels.map((label) => label.trim().toLowerCase()));
  if (rule.any_labels.some((label) => labels.has(label))) return true;
  if (rule.target_branches.includes(input.target_branch)) return true;
  return rule.paths.some((glob) => {
    const matcher = globToRegExp(glob);
    return input.changed_paths.some((changedPath) => matcher.test(changedPath));
  });
}

export function classifyMergeRisk(
  config: MergeConfig,
  input: { labels: string[]; changed_paths: string[]; target_branch: string },
): MergeRisk {
  let risk = config.default_risk;
  for (const rule of config.rules) {
    if (ruleMatches(rule, input) && RISK_RANK[rule.risk] > RISK_RANK[risk]) risk = rule.risk;
  }
  return risk;
}

export function evaluateMergeEligibility(input: {
  config: MergeConfig;
  risk: MergeRisk;
  pull_request: MergePolicyPullRequest;
  checks: MergeCheckResult[];
  receipts: VerificationReceipt[];
}): MergeEligibilityDecision {
  const { config, risk, pull_request: pr, checks, receipts } = input;
  const requiredReviews = risk === 'elevated' ? 2 : 1;
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

  const freshPassingReceiptIds = new Set(
    receipts
      .filter(
        (receipt) =>
          receipt.verdict === 'pass' &&
          Boolean(pr.head_sha) &&
          Boolean(pr.base_sha) &&
          receipt.head_sha === pr.head_sha &&
          receipt.base_sha === pr.base_sha,
      )
      .map((receipt) => receipt.receipt_id),
  );
  if (freshPassingReceiptIds.size < requiredReviews) {
    reasons.push(
      `requires ${requiredReviews} fresh passing verification receipt${requiredReviews === 1 ? '' : 's'}; found ${freshPassingReceiptIds.size}`,
    );
  }

  return { eligible: reasons.length === 0, risk, required_reviews: requiredReviews, reasons };
}
