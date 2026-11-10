import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { DashboardGithubCache } from './githubCache.js';
import { loadOverviewState, orchestratorHealth, sortAttention } from './overviewState.js';
import { resolveDashboardSources } from './sources.js';
import { createDashboardFixture, FIXTURE_NOW } from './testFixtures.js';

test('loadOverviewState builds orchestrator health, attention, running and repo summaries', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const overview = await loadOverviewState(sources, { now: FIXTURE_NOW });

  assert.equal(overview.source.kind, 'config');
  assert.equal(overview.orchestrator.alive, true);
  assert.equal(overview.orchestrator.level, 'ok');
  assert.equal(overview.orchestrator.running_agents, 1);

  assert.equal(overview.running.length, 1);
  const running = overview.running[0]!;
  assert.equal(running.task_key, 'x/1');
  assert.equal(running.elapsed_ms, 5 * 60_000);
  assert.equal(running.artifacts.agent_log, path.join(fixture.sessionDir, 'agent.jsonl'));
  assert.equal(running.last_activity, 'Reading the code');
  assert.equal(running.usage?.output_tokens, 20);

  const reasons = overview.attention.map((item) => item.reason);
  assert.deepEqual([...reasons].sort(), ['dispatch_deferred', 'merge_blocked', 'needs_info', 'protected_workspace', 'retry_exhausted'].sort());
  assert.equal(overview.attention[0]!.reason, 'retry_exhausted', 'bad items first');
  const merge = overview.attention.find((item) => item.reason === 'merge_blocked')!;
  assert.equal(merge.pr_number, 5);
  assert.equal(merge.task_key, 'x/1');
  assert.equal(merge.detail, 'check is not successful: test (in_progress); requires 1 review');
  assert.match(overview.attention.find((item) => item.reason === 'dispatch_deferred')!.detail ?? '', /1 deferral/);

  assert.equal(overview.repos.length, 1);
  assert.equal(overview.epics.length, 1);
  assert.deepEqual(overview.totals, { repos: 1, running: 1, queued: 0, retrying: 0, attention: 5, attention_bad: 1 });
});

test('orchestrator missing or old heartbeat is reported as down', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const missing = orchestratorHealth(null, sources, 0, FIXTURE_NOW);
  assert.equal(missing.alive, false);
  assert.equal(missing.level, 'bad');

  await fs.rm(path.join(fixture.root, '.symphony', 'heartbeat.json'));
  const overview = await loadOverviewState(sources, { now: FIXTURE_NOW });
  assert.equal(overview.attention[0]!.reason, 'orchestrator_down');

  const old = orchestratorHealth(
    {
      version: 1,
      pid: process.pid,
      started_at: FIXTURE_NOW.toISOString(),
      updated_at: new Date(FIXTURE_NOW.getTime() - 23 * 60_000).toISOString(),
      mode: 'config',
      source_path: fixture.configPath,
      polling_interval_ms: 60_000,
      max_concurrent_agents: 4,
      repo_ids: ['x'],
      shutting_down: false,
    },
    sources,
    0,
    FIXTURE_NOW,
  );
  assert.equal(old.alive, false);
  assert.equal(old.message, 'Heartbeat is 23m old');
});

test('sortAttention orders bad, warn, ok then newest first and dedupes ids', () => {
  const item = (id: string, level: 'ok' | 'warn' | 'bad', since: string) => ({
    id,
    reason: 'failed' as const,
    level,
    repo_id: null,
    task_key: null,
    title: id,
    detail: null,
    issue_number: null,
    issue_url: null,
    pr_number: null,
    pr_url: null,
    workspace_path: null,
    since,
  });
  const sorted = sortAttention([item('a', 'ok', '2026-01-03'), item('b', 'warn', '2026-01-01'), item('c', 'bad', '2026-01-01'), item('d', 'warn', '2026-01-02'), item('b', 'bad', '2026-01-09')]);
  assert.deepEqual(sorted.map((entry) => entry.id), ['c', 'd', 'b', 'a']);
});

test('GitHub enrichment comes from the cache and failures surface as github_backoff', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const ok = new DashboardGithubCache({
    clientFactory: () => ({
      listOpenPullRequests: async () => [],
      fetchIssueOrPullRequestByNumber: async (number) => ({
        id: `issue-${number}`,
        identifier: `acme/widget#${number}`,
        number,
        title: `Fresh title ${number}`,
        description: null,
        priority: null,
        state: 'open',
        workflow_state: number === 1 ? 'agent-running' : null,
        branch_name: null,
        url: `https://github.test/acme/widget/issues/${number}`,
        labels: number === 1 ? ['agent-running'] : [],
        assignees: [],
        milestone: null,
        blocked_by: [],
        pull_requests: [],
        created_at: null,
        updated_at: null,
        ready_for_agent_labeled_at: null,
      }),
    }),
  });
  const enriched = await loadOverviewState(sources, { now: FIXTURE_NOW, github: ok });
  assert.equal(enriched.running[0]!.title, 'Fresh title 1');
  // GitHub knows there are no open PRs, so the old merge block is not shown.
  assert.equal(enriched.attention.some((item) => item.reason === 'merge_blocked'), false);

  const failing = new DashboardGithubCache({
    clientFactory: () => ({
      listOpenPullRequests: async () => {
        throw new Error('GitHub is down');
      },
      fetchIssueOrPullRequestByNumber: async () => {
        throw new Error('GitHub is down');
      },
    }),
  });
  const degraded = await loadOverviewState(sources, { now: FIXTURE_NOW, github: failing });
  const flag = degraded.repos[0]!.flags.find((entry) => entry.kind === 'github_backoff');
  assert.match(flag?.message ?? '', /GitHub is down/);
  assert.ok(degraded.attention.some((item) => item.reason === 'github_backoff'));
  assert.equal(degraded.running[0]!.title, 'Issue 1', 'falls back to local titles');
});
