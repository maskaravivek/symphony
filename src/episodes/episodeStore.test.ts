import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EpisodeStore } from './episodeStore.js';

test('persists append-only episode events across store instances', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-episodes-'));
  const databasePath = path.join(root, 'episodes.sqlite');

  const first = new EpisodeStore(databasePath);
  first.append({
    repo_id: 'mdedit',
    episode_id: 'mdedit#42:attempt:1',
    event: 'run_started',
    payload: { issue_number: 42, attempt: 1 },
  });
  first.append({
    repo_id: 'mdedit',
    episode_id: 'mdedit#42:attempt:1',
    event: 'run_completed',
    payload: { issue_number: 42, exit_code: 0 },
  });
  first.close();

  const reopened = new EpisodeStore(databasePath);
  const events = reopened.list({ repo_id: 'mdedit', episode_id: 'mdedit#42:attempt:1' });
  const latest = reopened.latest({ repo_id: 'mdedit', episode_id: 'mdedit#42:attempt:1' });
  reopened.close();

  assert.equal(events.length, 2);
  assert.equal(events[0]?.event, 'run_started');
  assert.deepEqual(events[0]?.payload, { issue_number: 42, attempt: 1 });
  assert.match(events[0]?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(latest?.event, 'run_completed');
});
