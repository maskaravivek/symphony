import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowConfig } from '../../workflow/types.js';
import { DashboardGithubCache } from './githubCache.js';

const config = { tracker: { owner: 'acme', repo: 'widget' } } as unknown as WorkflowConfig;

function issue(number: number) {
  return {
    id: `i${number}`,
    identifier: `acme/widget#${number}`,
    number,
    title: `T${number}`,
    description: null,
    priority: null,
    state: 'open',
    workflow_state: null,
    branch_name: null,
    url: null,
    labels: [],
    assignees: [],
    milestone: null,
    blocked_by: [],
    pull_requests: [],
    created_at: null,
    updated_at: null,
    ready_for_agent_labeled_at: null,
  };
}

test('github cache refreshes once per TTL, bounds cold waits, and reports refreshes', async () => {
  let now = 0;
  let calls = 0;
  let release: () => void = () => {};
  let gate = Promise.resolve();
  const cache = new DashboardGithubCache({
    now: () => now,
    ttlMs: 1000,
    coldWaitMs: 20,
    clientFactory: () => ({
      listOpenPullRequests: async () => {
        calls += 1;
        await gate;
        return [];
      },
      fetchIssueOrPullRequestByNumber: async (number) => issue(number),
    }),
  });
  const refreshed: string[] = [];
  cache.onRefresh((repoId) => refreshed.push(repoId));

  const first = await cache.ensure('x', config, [1, 2]);
  assert.equal(first.issues.get(1)?.title, 'T1');
  assert.equal(calls, 1);
  assert.deepEqual(refreshed, ['x']);

  await cache.ensure('x', config, [1, 2]);
  assert.equal(calls, 1, 'fresh cache is not refetched');

  now = 2000;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stale = await cache.ensure('x', config, [1]);
  assert.equal(stale.refreshing, true, 'stale snapshot returned immediately while refreshing');
  const concurrent = await cache.ensure('x', config, [1]);
  assert.equal(concurrent.refreshing, true);
  assert.equal(calls, 2, 'single in-flight refresh');
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cache.snapshot('x').refreshing, false);

  const disabled = new DashboardGithubCache({ enabled: false, clientFactory: () => assert.fail('must not create a client') });
  assert.equal((await disabled.ensure('x', config, [1])).last_refreshed_at, null);
});

test('github cache cold wait never exceeds its bound', async () => {
  const cache = new DashboardGithubCache({
    coldWaitMs: 30,
    clientFactory: () => ({
      listOpenPullRequests: () => new Promise(() => {}),
      fetchIssueOrPullRequestByNumber: () => new Promise(() => {}),
    }),
  });
  const started = Date.now();
  const snapshot = await cache.ensure('x', config, [1]);
  assert.ok(Date.now() - started < 500);
  assert.equal(snapshot.last_refreshed_at, null);
  assert.equal(snapshot.refreshing, true);
});
