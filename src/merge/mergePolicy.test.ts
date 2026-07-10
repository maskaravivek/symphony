import assert from 'node:assert/strict';
import test from 'node:test';

import type { MergeConfig } from '../workflow/types.js';
import { classifyMergeRisk, evaluateMergeEligibility, type VerificationReceipt } from './mergePolicy.js';

const config: MergeConfig = {
  enabled: true,
  dry_run: false,
  method: 'squash',
  default_risk: 'standard',
  rules: [
    { risk: 'elevated', any_labels: ['security'], paths: ['.github/workflows/**', 'src/auth/**'], target_branches: [] },
    { risk: 'prohibited', any_labels: ['no-automerge'], paths: [], target_branches: ['production'] },
  ],
};

function receipt(id: string, overrides: Partial<VerificationReceipt> = {}): VerificationReceipt {
  return {
    receipt_id: id,
    verifier: 'post-run-review',
    verdict: 'pass',
    head_sha: 'head-1',
    base_sha: 'base-1',
    evidence: ['review completed'],
    verified_at: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

test('classifies the highest matching risk across labels, paths, and target branch', () => {
  assert.equal(classifyMergeRisk(config, { labels: [], changed_paths: ['docs/readme.md'], target_branch: 'main' }), 'standard');
  assert.equal(classifyMergeRisk(config, { labels: [], changed_paths: ['.github/workflows/ci.yml'], target_branch: 'main' }), 'elevated');
  assert.equal(
    classifyMergeRisk(config, { labels: ['security'], changed_paths: ['src/auth/login.ts'], target_branch: 'production' }),
    'prohibited',
  );
});

test('allows a standard PR only after all deterministic gates pass', () => {
  const decision = evaluateMergeEligibility({
    config,
    risk: 'standard',
    pull_request: {
      state: 'open',
      is_draft: false,
      merge_state_status: 'clean',
      head_sha: 'head-1',
      base_sha: 'base-1',
      linked_issue_number: 42,
      labels: ['symphony-review:passed'],
    },
    checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    receipts: [receipt('review-1')],
  });
  assert.deepEqual(decision, { eligible: true, risk: 'standard', required_reviews: 1, reasons: [] });
});

test('requires two fresh receipts for elevated risk and rejects stale receipts', () => {
  const base = {
    config,
    risk: 'elevated' as const,
    pull_request: {
      state: 'open',
      is_draft: false,
      merge_state_status: 'clean',
      head_sha: 'head-1',
      base_sha: 'base-1',
      linked_issue_number: 42,
      labels: ['symphony-review:passed'],
    },
    checks: [{ name: 'test', status: 'completed' as const, conclusion: 'success' as const }],
  };
  const one = evaluateMergeEligibility({ ...base, receipts: [receipt('review-1')] });
  assert.equal(one.eligible, false);
  assert.ok(one.reasons.includes('requires 2 fresh passing verification receipts; found 1'));

  const stale = evaluateMergeEligibility({
    ...base,
    receipts: [receipt('review-1'), receipt('review-2', { base_sha: 'old-base' })],
  });
  assert.equal(stale.eligible, false);
  assert.ok(stale.reasons.includes('requires 2 fresh passing verification receipts; found 1'));

  const two = evaluateMergeEligibility({ ...base, receipts: [receipt('review-1'), receipt('review-2')] });
  assert.equal(two.eligible, true);
});

test('blocks prohibited, draft, conflicted, pending-check, paused, and unlinked PRs', () => {
  const decision = evaluateMergeEligibility({
    config,
    risk: 'prohibited',
    pull_request: {
      state: 'open',
      is_draft: true,
      merge_state_status: 'dirty',
      head_sha: 'head-1',
      base_sha: 'base-1',
      linked_issue_number: null,
      labels: ['needs-info'],
    },
    checks: [{ name: 'test', status: 'in_progress', conclusion: null }],
    receipts: [receipt('review-1')],
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.includes('risk is prohibited'));
  assert.ok(decision.reasons.includes('pull request is a draft'));
  assert.ok(decision.reasons.includes('pull request is not mergeable: dirty'));
  assert.ok(decision.reasons.includes('no linked issue'));
  assert.ok(decision.reasons.includes('blocking workflow label: needs-info'));
  assert.ok(decision.reasons.includes('check is not successful: test (in_progress)'));
});

test('treats missing checks and unavailable verification as blocking evidence gaps', () => {
  const decision = evaluateMergeEligibility({
    config,
    risk: 'standard',
    pull_request: {
      state: 'open',
      is_draft: false,
      merge_state_status: 'clean',
      head_sha: 'head-1',
      base_sha: 'base-1',
      linked_issue_number: 42,
      labels: [],
    },
    checks: [],
    receipts: [receipt('review-1', { verdict: 'unavailable' })],
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.includes('no check results available'));
  assert.ok(decision.reasons.includes('requires 1 fresh passing verification receipt; found 0'));
});
