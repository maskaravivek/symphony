import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequestRef } from '../github/githubClient.js';
import type { MergeConfig } from '../workflow/types.js';
import { assessAndMaybeMerge } from './autonomousMerge.js';
import type { VerificationReceipt } from './mergePolicy.js';

const pr: PullRequestRef = {
  number: 42,
  title: 'Safe change',
  body: 'Fixes #17',
  state: 'open',
  labels: ['symphony-review:passed'],
  is_draft: false,
  url: 'https://github.test/pull/42',
  head_ref: 'feature',
  head_sha: 'head-sha',
  base_ref: 'main',
  base_sha: 'base-sha',
  merge_state_status: 'clean',
};

const config: MergeConfig = {
  enabled: true,
  dry_run: false,
  method: 'squash',
  default_risk: 'standard',
  rules: [],
};

const receipt: VerificationReceipt = {
  receipt_id: 'review-1',
  verifier: 'post-run-review',
  verdict: 'pass',
  head_sha: 'head-sha',
  base_sha: 'base-sha',
  evidence: ['no blocking findings'],
  verified_at: '2026-07-10T00:00:00.000Z',
};

test('assesses current GitHub evidence and merges with the expected head SHA', async () => {
  const mergeCalls: unknown[] = [];
  const result = await assessAndMaybeMerge({
    config,
    pull_request: pr,
    linked_issue_number: 17,
    receipts: [receipt],
    github: {
      listPullRequestFiles: async () => ['src/editor.ts'],
      listPullRequestChecks: async () => [{ name: 'test', status: 'completed', conclusion: 'success', url: null }],
      mergePullRequest: async (number, options) => {
        mergeCalls.push({ number, options });
        return { merged: true, message: 'merged', sha: 'merge-sha' };
      },
    },
  });

  assert.equal(result.decision.eligible, true);
  assert.equal(result.action, 'merged');
  assert.deepEqual(mergeCalls, [{ number: 42, options: { expectedHeadSha: 'head-sha', method: 'squash' } }]);
});

test('merges an eligible standard PR when GitHub checks are optional and absent', async () => {
  const mergeCalls: unknown[] = [];
  const result = await assessAndMaybeMerge({
    config: { ...config, require_checks: false },
    pull_request: pr,
    linked_issue_number: 17,
    receipts: [receipt],
    github: {
      listPullRequestFiles: async () => ['src/editor.ts'],
      listPullRequestChecks: async () => [],
      mergePullRequest: async (number, options) => {
        mergeCalls.push({ number, options });
        return { merged: true, message: 'merged', sha: 'merge-sha' };
      },
    },
  });

  assert.equal(result.action, 'merged');
  assert.deepEqual(mergeCalls, [{ number: 42, options: { expectedHeadSha: 'head-sha', method: 'squash' } }]);
});

test('reports dry-run eligibility without calling merge', async () => {
  let merged = false;
  const result = await assessAndMaybeMerge({
    config: { ...config, dry_run: true },
    pull_request: pr,
    linked_issue_number: 17,
    receipts: [receipt],
    github: {
      listPullRequestFiles: async () => ['src/editor.ts'],
      listPullRequestChecks: async () => [{ name: 'test', status: 'completed', conclusion: 'success', url: null }],
      mergePullRequest: async () => {
        merged = true;
        return { merged: true, message: 'merged', sha: 'merge-sha' };
      },
    },
  });
  assert.equal(result.action, 'dry-run');
  assert.equal(merged, false);
});

test('does not call merge when policy evidence is incomplete', async () => {
  let merged = false;
  const result = await assessAndMaybeMerge({
    config,
    pull_request: pr,
    linked_issue_number: null,
    receipts: [],
    github: {
      listPullRequestFiles: async () => ['src/editor.ts'],
      listPullRequestChecks: async () => [],
      mergePullRequest: async () => {
        merged = true;
        return { merged: true, message: 'merged', sha: 'merge-sha' };
      },
    },
  });
  assert.equal(result.action, 'blocked');
  assert.equal(merged, false);
  assert.ok(result.decision.reasons.includes('no linked issue'));
});
