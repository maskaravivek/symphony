import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeServerConfig } from './loadServerConfig.js';

test('normalizes a multi-repo server config', () => {
  const config = normalizeServerConfig(
    {
      polling: { interval_ms: 15000 },
      agent: { max_concurrent_agents: 4 },
      repos: [
        { id: 'mdedit', workflow: './WORKFLOW.md', max_concurrent_agents: 2 },
        { id: 'myaarti', workflow: '~/myaarti/WORKFLOW.md', enabled: false },
      ],
    },
    '/tmp/symphony.config.yml',
  );

  assert.equal(config.polling.interval_ms, 15000);
  assert.equal(config.agent.max_concurrent_agents, 4);
  assert.equal(config.repos[0]?.id, 'mdedit');
  assert.equal(config.repos[0]?.workflow, '/tmp/WORKFLOW.md');
  assert.equal(config.repos[0]?.max_concurrent_agents, 2);
  assert.equal(config.repos[0]?.enabled, true);
  assert.equal(config.repos[1]?.enabled, false);
  assert.deepEqual(config.repository_sync, { enabled: false, interval_ms: 43_200_000 });
});

test('loads the opt-in twelve-hour repository sync and rejects invalid intervals', () => {
  const raw = { repository_sync: { enabled: true, interval_ms: 43_200_000 }, repos: [] };
  assert.deepEqual(normalizeServerConfig(raw, '/tmp/symphony.yml').repository_sync, raw.repository_sync);
  assert.throws(() => normalizeServerConfig({ ...raw, repository_sync: { interval_ms: 0 } }, '/tmp/symphony.yml'), /positive number/);
  assert.throws(() => normalizeServerConfig({ ...raw, repository_sync: { enabled: 'yes' } }, '/tmp/symphony.yml'), /boolean/);
});

test('rejects duplicate repo ids', () => {
  assert.throws(
    () =>
      normalizeServerConfig(
        {
          repos: [
            { id: 'mdedit', workflow: './WORKFLOW.md' },
            { id: 'mdedit', workflow: './OTHER.md' },
          ],
        },
        '/tmp/symphony.config.yml',
      ),
    /duplicate repo id: mdedit/,
  );
});
