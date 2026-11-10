import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { EpisodeStore } from '../../episodes/episodeStore.js';
import { loadEventsPage } from './historyState.js';
import { loadRepoState } from './repoState.js';
import { resolveDashboardSources } from './sources.js';
import { createDashboardFixture, FIXTURE_NOW } from './testFixtures.js';

const RAW_CLOSES = 600;

async function fixtureWithNoisyCloses() {
  const fixture = await createDashboardFixture();
  const store = new EpisodeStore(path.join(fixture.workspaceRoot, '.symphony', 'episodes.sqlite'));
  try {
    // The orchestrator re-records issue.closed for already-closed issues on every poll.
    for (let index = 0; index < RAW_CLOSES; index += 1) {
      const issue = index % 2 === 0 ? 32 : 34;
      store.append({
        repo_id: 'x',
        episode_id: `acme/widget#${issue}:outcome`,
        event: 'issue.closed',
        payload: { issue_number: issue, issue_state: 'closed', run_status: 'completed' },
        created_at: new Date(FIXTURE_NOW.getTime() + index * 1000).toISOString(),
      });
    }
  } finally {
    store.close();
  }
  return fixture;
}

test('recent_events collapses repeated issue.closed rows per issue', async () => {
  const fixture = await fixtureWithNoisyCloses();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const repo = await loadRepoState(sources, 'x', { now: FIXTURE_NOW });
  const closes = repo.recent_events.filter((event) => event.event === 'issue.closed');
  assert.deepEqual(closes.map((event) => event.issue_number), [34, 32]);
  assert.equal(closes[0]!.repeat_count, RAW_CLOSES / 2, 'window grows past the repeats');
  assert.ok(closes[0]!.first_at! < closes[0]!.created_at);
  assert.equal(closes[0]!.summary, '#34: issue closed (run completed)');
  assert.equal(closes[0]!.created_at, new Date(FIXTURE_NOW.getTime() + (RAW_CLOSES - 1) * 1000).toISOString());
});

test('events pages collapse repeats without skipping or duplicating raw rows', async () => {
  const fixture = await fixtureWithNoisyCloses();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const totalRaw = RAW_CLOSES + 9;

  for (const repo of ['x', null]) {
    let before: number | string | null = null;
    let accounted = 0;
    let pages = 0;
    const seen = new Set<string>();
    do {
      const page = await loadEventsPage(sources, { repo, limit: 3, before, now: FIXTURE_NOW });
      pages += 1;
      assert.ok(page.events.length <= 3);
      for (const event of page.events) {
        const id = `${event.sequence}`;
        assert.ok(!seen.has(id), `sequence ${id} returned twice`);
        seen.add(id);
        accounted += event.repeat_count ?? 1;
      }
      before = page.next_before;
      assert.ok(pages < 200, 'paging terminates');
    } while (before !== null);
    assert.equal(accounted, totalRaw, `every raw row accounted for exactly once (repo=${repo})`);
    assert.ok(pages <= Math.ceil(totalRaw / 15) + 3, 'each page consumes up to the 5x raw window');
  }
});
