import assert from 'node:assert/strict';
import test from 'node:test';

import { DashboardNotFoundError } from './context.js';
import { loadRepoState } from './repoState.js';
import { resolveDashboardSources } from './sources.js';
import { createDashboardFixture, FIXTURE_NOW } from './testFixtures.js';

test('loadRepoState returns the repo summary plus tasks, slots, loops, PRs and recent events', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const repo = await loadRepoState(sources, 'x', { now: FIXTURE_NOW });

  assert.equal(repo.repo_id, 'x');
  assert.equal(repo.owner, 'acme');
  assert.equal(repo.heartbeat?.repo_id, 'x');
  assert.equal(repo.slots.length, 5);
  assert.equal(repo.retry_queue.length, 1);
  assert.equal(repo.loops[0]!.loop_id, 'daily');
  assert.equal(repo.epics.length, 1);
  assert.deepEqual(repo.tasks.slice(0, 1).map((task) => task.lifecycle), ['running']);
  assert.ok(repo.tasks.every((task, index, all) => task.lifecycle !== 'closed' || all.slice(index).every((rest) => rest.lifecycle === 'closed')));

  assert.equal(repo.recent_events.length, 9);
  assert.equal(repo.recent_events[0]!.event, 'merge.blocked', 'newest first');
  assert.equal(repo.recent_events[0]!.task_key, 'x/1');
  assert.match(repo.recent_events[0]!.summary, /^PR #5: merge blocked: check is not successful/);

  // Without GitHub data the PR list comes from local PR-review runs only (none in the fixture).
  assert.deepEqual(repo.pull_requests, []);

  await assert.rejects(loadRepoState(sources, 'nope'), DashboardNotFoundError);
});
