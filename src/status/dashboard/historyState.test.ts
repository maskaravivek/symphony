import assert from 'node:assert/strict';
import test from 'node:test';

import { isoWeekStart, loadEventsPage, loadHistoryState, normalizeReason, parseTaskKey } from './historyState.js';
import { resolveDashboardSources } from './sources.js';
import { createDashboardFixture, FIXTURE_NOW } from './testFixtures.js';

test('isoWeekStart, normalizeReason and parseTaskKey', () => {
  assert.equal(isoWeekStart(new Date('2026-11-10T12:00:00Z')), '2026-11-09');
  assert.equal(isoWeekStart(new Date('2026-11-09T00:00:00Z')), '2026-11-09');
  assert.equal(isoWeekStart(new Date('2026-11-08T23:59:59Z')), '2026-11-02');
  assert.equal(normalizeReason('preparation_error: Linked workspace contains protected work'), 'preparation_error');
  assert.equal(normalizeReason(`  ${'x'.repeat(100)}  `).length, 80);
  assert.deepEqual(parseTaskKey('x/12'), { repoId: 'x', issueNumber: 12, loopId: null });
  assert.deepEqual(parseTaskKey('x/loop/daily'), { repoId: 'x', issueNumber: null, loopId: 'daily' });
  assert.equal(parseTaskKey('garbage'), null);
});

test('loadHistoryState buckets episode events by ISO week', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const history = await loadHistoryState(sources, { days: 14, now: FIXTURE_NOW });
  assert.equal(history.window.days, 14);
  const repo = history.repos[0]!;
  assert.equal(repo.repo_id, 'x');
  assert.deepEqual(repo.weeks.map((week) => week.week_start), ['2026-10-26', '2026-11-02', '2026-11-09']);
  const lastWeek = repo.weeks.find((week) => week.week_start === '2026-11-02')!;
  assert.equal(lastWeek.merged, 1);
  // #3 started 3 days before "now", PR #4 merged 2 days before: one day claim-to-merge.
  assert.equal(lastWeek.median_claim_to_merge_ms, 24 * 60 * 60_000);
  const thisWeek = repo.weeks.find((week) => week.week_start === '2026-11-09')!;
  assert.equal(thisWeek.retries, 2);
  assert.equal(thisWeek.failed, 1);
  assert.equal(thisWeek.loops_completed, 1);
  assert.equal(thisWeek.median_claim_to_merge_ms, null);
  assert.deepEqual(repo.top_retry_reasons, [{ reason: 'nonzero_exit', count: 2 }]);
  assert.deepEqual(repo.top_failure_reasons, [{ reason: 'nonzero_exit', count: 1 }]);
  assert.deepEqual(repo.top_merge_block_reasons, [
    { reason: 'check is not successful', count: 1 },
    { reason: 'requires 1 review', count: 1 },
  ]);
});

test('loadEventsPage pages newest first and filters by task', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const first = await loadEventsPage(sources, { repo: 'x', limit: 4, now: FIXTURE_NOW });
  assert.equal(first.events.length, 4);
  assert.equal(first.events[0]!.event, 'merge.blocked');
  assert.ok(first.next_before !== null);
  const second = await loadEventsPage(sources, { repo: 'x', limit: 10, before: first.next_before });
  assert.equal(second.events.length, 5);
  assert.equal(second.next_before, null);
  assert.ok(second.events[0]!.sequence < first.events[3]!.sequence);

  const task = await loadEventsPage(sources, { task: 'x/2', limit: 10 });
  assert.deepEqual(task.events.map((event) => event.event), ['workflow.failed', 'workflow.retry_scheduled', 'workflow.retry_scheduled']);
  assert.equal(task.events[1]!.level, 'warn');

  const all = await loadEventsPage(sources, { limit: 3 });
  assert.equal(all.events.length, 3);
  assert.equal(typeof all.next_before, 'string');
  const rest = await loadEventsPage(sources, { limit: 50, before: all.next_before });
  assert.equal(rest.events.length, 6);
});

test('cross-repository pagination preserves events with matching timestamps and sequences', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  sources.repos.push({ ...sources.repos[0]!, repo_id: 'y' });
  const first = await loadEventsPage(sources, { limit: 1 });
  const second = await loadEventsPage(sources, { limit: 1, before: first.next_before });
  assert.equal(first.events[0]?.repo_id, 'x');
  assert.equal(second.events[0]?.repo_id, 'y');
  assert.equal(second.events[0]?.created_at, first.events[0]?.created_at);
  assert.equal(second.events[0]?.sequence, first.events[0]?.sequence);
});
