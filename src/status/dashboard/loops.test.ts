import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { EpisodeStore } from '../../episodes/episodeStore.js';
import { loadRepoLocalState } from './localState.js';
import { loadRepoState } from './repoState.js';
import { resolveDashboardSources } from './sources.js';
import { loadTaskDetail } from './taskState.js';
import { createDashboardFixture, FIXTURE_NOW } from './testFixtures.js';

const minutesAgo = (minutes: number) => new Date(FIXTURE_NOW.getTime() - minutes * 60_000).toISOString();

test('a loop whose run.json was cleaned is derived from its loop episodes', async () => {
  const fixture = await createDashboardFixture();
  await fs.rm(path.join(fixture.workspaceRoot, '_loops', 'daily', '.symphony', 'run.json'));
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });

  const completed = await loadTaskDetail(sources, 'x', { loopId: 'daily' }, { now: FIXTURE_NOW });
  assert.equal(completed.run_state, null);
  assert.equal(completed.loop?.status, 'completed');
  assert.equal(completed.loop?.last_started_at, minutesAgo(70));
  assert.equal(completed.loop?.last_finished_at, minutesAgo(60));
  assert.equal(completed.loop?.last_outcome, 'completed');
  assert.equal(completed.loop?.next_due_at, new Date(Date.parse(minutesAgo(70)) + 86_400_000).toISOString());
  assert.equal(completed.task.updated_at, minutesAgo(60));
  assert.equal(completed.task.lifecycle, 'queued');

  const store = new EpisodeStore(path.join(fixture.workspaceRoot, '.symphony', 'episodes.sqlite'));
  store.append({ repo_id: 'x', episode_id: 'loop-daily', event: 'loop.triggered', payload: { loop_id: 'daily' }, created_at: minutesAgo(20) });
  store.append({
    repo_id: 'x',
    episode_id: 'loop-daily',
    event: 'loop.failed',
    payload: { loop_id: 'daily', reason: 'preparation_failed', error: 'Legacy workspace contains protected work' },
    created_at: minutesAgo(19),
  });
  store.close();
  const repo = await loadRepoState(sources, 'x', { now: FIXTURE_NOW });
  const loop = repo.loops.find((entry) => entry.loop_id === 'daily')!;
  assert.equal(loop.status, 'failed');
  assert.equal(loop.last_started_at, minutesAgo(20));
  assert.equal(loop.last_error, 'preparation_failed: Legacy workspace contains protected work');
  const task = repo.tasks.find((entry) => entry.task_key === 'x/loop/daily')!;
  assert.equal(task.lifecycle, 'failed');
  assert.equal(task.status, 'failed');
  assert.equal(task.updated_at, minutesAgo(19));
});

test('disabled and never-run loops get honest lifecycle and timestamps', async () => {
  const fixture = await createDashboardFixture();
  const workflow = await fs.readFile(fixture.workflowPath, 'utf8');
  await fs.writeFile(
    fixture.workflowPath,
    workflow.replace(
      '    prompt: Tidy up\n',
      '    prompt: Tidy up\n    enabled: false\n  - id: weekly\n    interval_ms: 604800000\n    prompt: Review\n',
    ),
    'utf8',
  );
  await fs.mkdir(path.join(fixture.workspaceRoot, '_loops', 'weekly'), { recursive: true });
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const local = await loadRepoLocalState(sources.repos[0]!, { now: FIXTURE_NOW });

  const daily = local.loops.find((loop) => loop.loop_id === 'daily')!;
  assert.equal(daily.enabled, false);
  assert.equal(daily.next_due_at, null);
  assert.equal(local.tasks.find((task) => task.task_key === 'x/loop/daily')?.lifecycle, 'closed');

  const weekly = local.loops.find((loop) => loop.loop_id === 'weekly')!;
  assert.equal(weekly.status, 'never-run');
  assert.equal(weekly.last_started_at, null);
  const weeklyTask = local.tasks.find((task) => task.task_key === 'x/loop/weekly')!;
  assert.equal(weeklyTask.lifecycle, 'queued');
  assert.notEqual(weeklyTask.updated_at, new Date(0).toISOString());
  assert.ok(Date.parse(weeklyTask.updated_at) > Date.parse('2020-01-01'), 'workspace mtime, not epoch');
  assert.equal(local.summary.counts.queued, 0, 'idle loops are not queued work');
});
