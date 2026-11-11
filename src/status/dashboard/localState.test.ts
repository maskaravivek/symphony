import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadRepoLocalState, lifecycleFor } from './localState.js';
import { resolveDashboardSources } from './sources.js';
import { createDashboardFixture, fixtureRunState, FIXTURE_NOW } from './testFixtures.js';

test('resolveDashboardSources mirrors loadBoardState repo resolution', async () => {
  const fixture = await createDashboardFixture();
  const config = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  assert.equal(config.source.kind, 'config');
  assert.equal(config.control_dir, fixture.root);
  assert.equal(config.polling_interval_ms, 60_000);
  assert.deepEqual(config.repos.map((repo) => repo.repo_id), ['x']);
  assert.equal(config.repos[0]!.workflow_path, fixture.workflowPath);
  assert.deepEqual(config.allowed_roots, [fixture.workspaceRoot]);

  const workflow = await resolveDashboardSources({ workflow: fixture.workflowPath, fresh: true });
  assert.equal(workflow.source.kind, 'workflow');
  assert.deepEqual(workflow.repos.map((repo) => repo.repo_id), ['default']);
  assert.equal(workflow.repos[0]!.workspace_root, fixture.workspaceRoot);
});

test('lifecycleFor maps board columns and retry-wait', () => {
  const base = fixtureRunState('/tmp/w');
  assert.equal(lifecycleFor(base, ['closed']), 'running');
  assert.equal(lifecycleFor({ ...base, status: 'retry-wait', labels: ['ready-for-agent'], workflow_state: 'ready-for-agent' }, ['closed']), 'retrying');
  assert.equal(lifecycleFor({ ...base, status: 'cancelled', labels: [], workflow_state: null }, ['closed']), 'cancelled');
  assert.equal(lifecycleFor({ ...base, status: 'failed', labels: [], workflow_state: null }, ['closed']), 'failed');
  assert.equal(lifecycleFor({ ...base, status: 'completed', issue_state: 'closed' }, ['closed']), 'closed');
});

test('loadRepoLocalState reads tasks, slots, loops, retries, epics and flags from disk only', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const local = await loadRepoLocalState(sources.repos[0]!, { now: FIXTURE_NOW });

  const byKey = new Map(local.tasks.map((task) => [task.task_key, task]));
  assert.equal(byKey.get('x/1')?.lifecycle, 'running');
  assert.equal(byKey.get('x/1')?.stale, false);
  assert.equal(byKey.get('x/1')?.pr_number, 5, 'PR linked from the merge.blocked episode');
  assert.equal(byKey.get('x/2')?.lifecycle, 'failed');
  assert.equal(byKey.get('x/3')?.lifecycle, 'needs-info');
  assert.equal(byKey.get('x/10')?.kind, 'epic');
  assert.equal(byKey.get('x/10')?.epic_progress, '1/2');
  assert.equal(byKey.get('x/loop/daily')?.kind, 'loop');

  const slots = new Map(local.slots.map((slot) => [slot.name, slot]));
  assert.equal(slots.get('_pool_1')?.state, 'running');
  assert.equal(slots.get('_pool_2')?.state, 'failed');
  assert.equal(slots.get('_pool_3')?.state, 'protected');
  assert.equal(slots.get('acme_widget_3')?.kind, 'dedicated');
  assert.equal(slots.get('acme_widget_3')?.state, 'paused');
  assert.equal(slots.get('_loops/daily')?.kind, 'loop');
  assert.equal(slots.get('_loops/daily')?.state, 'completed');
  assert.equal(slots.get('_pool_3')?.path, path.join(fixture.workspaceRoot, '_pool_3'));

  assert.deepEqual(local.summary.pool, { slots_total: 3, slots_max: 3, slots_in_use: 1, slots_protected: 1, slots_idle: 1 });
  assert.equal(local.retry_queue.length, 1);
  assert.equal(local.retry_queue[0]!.setup_failure, true);
  assert.equal(local.retry_queue[0]!.task_key, 'x/7');

  const loop = local.loops[0]!;
  assert.equal(loop.status, 'completed');
  assert.equal(loop.next_due_at, new Date(FIXTURE_NOW.getTime() - 70 * 60_000 + 86_400_000).toISOString());

  assert.equal(local.epics[0]!.children[0]!.lifecycle, 'running');
  assert.equal(local.summary.counts.running, 1);
  assert.equal(local.summary.counts.needs_info, 1);
  assert.equal(local.summary.counts.failed, 1);
  assert.equal(local.summary.counts.epics_coordinating, 1);
  assert.equal(local.summary.counts.loops, 1);
  assert.equal(local.summary.capacity.remaining, 1);
  const flagKinds = local.summary.flags.map((flag) => flag.kind).sort();
  assert.deepEqual(flagKinds, ['dispatch_deferred', 'protected_workspaces', 'retry_exhausted']);
  assert.equal(local.summary.level, 'bad');
});

test('only running tasks past stale_after_ms are stale', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const later = new Date(FIXTURE_NOW.getTime() + 60 * 60_000);
  const local = await loadRepoLocalState(sources.repos[0]!, { now: later });
  assert.deepEqual(local.tasks.filter((task) => task.stale).map((task) => task.task_key), ['x/1']);
});

test('ready GitHub labels clear a local needs-info pause and a later start clears a dispatch warning', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const workspace = path.join(fixture.workspaceRoot, '_pool_1');
  const { writeRunState } = await import('../runState.js');
  await writeRunState(workspace, fixtureRunState(workspace, {
    issue_number: 8,
    started_at: new Date(FIXTURE_NOW.getTime() - 30_000).toISOString(),
  }));
  const local = await loadRepoLocalState(sources.repos[0]!, {
    now: FIXTURE_NOW,
    github: {
      issues: new Map([[3, {
        number: 3, identifier: 'acme/widget#3', title: 'Answered', labels: ['ready-for-agent'],
        state: 'open', workflow_state: 'ready-for-agent', url: null, updated_at: FIXTURE_NOW.toISOString(),
      }]]),
      pull_requests: [], last_refreshed_at: FIXTURE_NOW.toISOString(), last_error: null,
      backoff_until: null, refreshing: false,
    },
  });
  const task = local.tasks.find(task => task.issue_number === 3);
  assert.equal(task?.lifecycle, 'queued');
  assert.equal(task?.pause_reason, null);
  assert.equal(local.slots.find(slot => slot.issue_number === 3)?.state, 'paused', 'keep the checkout available for resume');
  assert.deepEqual(local.dispatch_deferrals, []);
  assert.ok(!local.summary.flags.some(flag => flag.kind === 'dispatch_deferred'));
});
