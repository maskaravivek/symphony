import assert from 'node:assert/strict';
import test from 'node:test';

import type { MergeConfig } from '../workflow/types.js';
import {
  classifyMergeRisk,
  evaluateMergeEligibility,
  requiredMergeEvidence,
  summarizeSubstantiveChanges,
  type VerificationReceipt,
} from './mergePolicy.js';

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
  assert.deepEqual(decision, {
    eligible: true,
    risk: 'standard',
    required_reviews: 1,
    required_evidence: ['review'],
    observed_evidence: ['review'],
    reasons: [],
  });
});

test('allows a standard PR without GitHub checks when checks are optional', () => {
  const decision = evaluateMergeEligibility({
    config: { ...config, require_checks: false },
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
    checks: [],
    receipts: [receipt('review-1')],
  });

  assert.equal(decision.eligible, true);
  assert.deepEqual(decision.reasons, []);
});

test('blocks a known failing check even when checks are optional', () => {
  const decision = evaluateMergeEligibility({
    config: { ...config, require_checks: false },
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
    checks: [{ name: 'preview', status: 'completed', conclusion: 'failure' }],
    receipts: [receipt('review-1')],
  });

  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.includes('check is not successful: preview (completed/failure)'));
});

test('allows elevated risk with one fresh passing review and rejects stale reviews', () => {
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
  assert.equal(one.eligible, true);
  assert.equal(one.required_reviews, 1);

  const stale = evaluateMergeEligibility({
    ...base,
    receipts: [receipt('review-1', { head_sha: 'old-head' }), receipt('review-2', { base_sha: 'old-base' })],
  });
  assert.equal(stale.eligible, false);
  assert.ok(stale.reasons.includes('requires 1 fresh independent passing review; found 0'));
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
      labels: ['needs-info', 'symphony-failed'],
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
  assert.ok(decision.reasons.includes('blocking workflow label: symphony-failed'));
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
  assert.ok(decision.reasons.includes('requires 1 fresh independent passing review; found 0'));
  assert.ok(decision.reasons.includes('required verification evidence is missing: review'));
});

test('uses substantive size thresholds and path-specific evidence requirements', () => {
  const sizeConfig: MergeConfig = {
    ...config,
    substantive_ignored_paths: ['**/*.test.ts', 'generated/**'],
    rules: [
      ...config.rules,
      { risk: 'elevated', any_labels: [], paths: [], target_branches: [], min_changed_lines: 500, required_evidence: ['test'] },
      { risk: 'standard', any_labels: [], paths: ['apps/web/**'], target_branches: [], required_evidence: ['browser-observation'] },
    ],
  };
  const summary = summarizeSubstantiveChanges(sizeConfig, [
    { path: 'src/large.ts', additions: 350, deletions: 150 },
    { path: 'src/large.test.ts', additions: 900, deletions: 0 },
  ]);
  const input = { labels: [], changed_paths: ['src/large.ts', 'src/large.test.ts'], target_branch: 'main', ...summary };
  assert.deepEqual(summary, { substantive_changed_lines: 500, substantive_changed_files: 1 });
  assert.equal(classifyMergeRisk(sizeConfig, input), 'elevated');
  assert.deepEqual(requiredMergeEvidence(sizeConfig, 'elevated', input), ['review', 'test']);

  assert.deepEqual(
    requiredMergeEvidence(sizeConfig, 'standard', {
      labels: [],
      changed_paths: ['apps/web/page.tsx'],
      target_branch: 'main',
    }),
    ['browser-observation', 'review'],
  );
});

test('rejects self-review when an independent reviewer is required', () => {
  const independentConfig: MergeConfig = { ...config, require_independent_reviews: true };
  const decision = evaluateMergeEligibility({
    config: independentConfig,
    risk: 'elevated',
    pull_request: {
      state: 'open', is_draft: false, merge_state_status: 'clean', head_sha: 'head-1', base_sha: 'base-1', linked_issue_number: 42, labels: [],
    },
    checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    receipts: [
      receipt('one', { reviewer: { execution_id: 'author', provider: 'codex', model: null, lens: 'general' }, author_execution_id: 'author' }),
    ],
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.includes('requires 1 fresh independent passing review; found 0'));
});

test('invalidates receipts when the workflow policy changes', () => {
  const workflowConfig: MergeConfig = { ...config, workflow_sha: 'workflow-new' };
  const decision = evaluateMergeEligibility({
    config: workflowConfig,
    risk: 'standard',
    pull_request: {
      state: 'open', is_draft: false, merge_state_status: 'clean', head_sha: 'head-1', base_sha: 'base-1', linked_issue_number: 42, labels: [],
    },
    checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    receipts: [receipt('old', { workflow_sha: 'workflow-old' })],
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.includes('requires 1 fresh independent passing review; found 0'));
});

test('review-free merges require local validation and still block failed checks and human pauses', () => {
  const base = {
    config: { ...config, required_reviews: 0, validation_command: 'yarn test', require_checks: false },
    risk: 'elevated' as const,
    pull_request: {
      state: 'open', is_draft: false, merge_state_status: 'clean', head_sha: 'head-1', base_sha: 'base-1', linked_issue_number: 42, labels: [] as string[],
    },
    checks: [],
    receipts: [receipt('validation', { reviewer: null, evidence: [{ kind: 'validation', summary: 'tests passed', command: 'yarn test', artifact: null }] })],
  };
  const passed = evaluateMergeEligibility(base);
  assert.equal(passed.eligible, true);
  assert.equal(passed.required_reviews, 0);
  assert.deepEqual(passed.observed_evidence, ['validation']);
  assert.equal(evaluateMergeEligibility({ ...base, receipts: [] }).eligible, false);
  assert.equal(evaluateMergeEligibility({ ...base, receipts: [receipt('review-only')] }).eligible, false);
  assert.equal(evaluateMergeEligibility({ ...base, receipts: [receipt('stale', { ...base.receipts[0], head_sha: 'old-head' })] }).eligible, false);
  assert.equal(evaluateMergeEligibility({ ...base, required_evidence: [], receipts: [] }).eligible, false);
  assert.equal(evaluateMergeEligibility({ ...base, checks: [{ name: 'build', status: 'completed', conclusion: 'failure' }] }).eligible, false);
  assert.equal(evaluateMergeEligibility({ ...base, pull_request: { ...base.pull_request, labels: ['needs-info'] } }).eligible, false);
  assert.equal(evaluateMergeEligibility({ ...base, risk: 'prohibited' }).eligible, false);
});
