import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from '../orchestrator/orchestrator.js';
import type { OrchestratorHeartbeat, RepoHeartbeat } from './dashboardTypes.js';
import {
  orchestratorHeartbeatPath,
  readOrchestratorHeartbeat,
  readRepoHeartbeat,
  repoHeartbeatPath,
  writeOrchestratorHeartbeat,
  writeRepoHeartbeat,
} from './heartbeat.js';

function sampleRepoHeartbeat(): RepoHeartbeat {
  return {
    version: 1,
    repo_id: 'mdedit',
    owner: 'mangoappstudio',
    repo: 'mdedit',
    pid: 123,
    tick_started_at: '2026-11-10T00:00:00.000Z',
    tick_finished_at: '2026-11-10T00:00:01.000Z',
    tick_outcome: 'ok',
    tick_skip_reason: null,
    tick_error: null,
    poll: { candidate_count: 2, grooming_count: 0, active_count: 1, retry_count: 0, capacity_remaining: null },
    capacity: { max_concurrent_agents: 2, running: 1 },
    storage: { blocked: false, minimum_free_gib: 20, free_gib: 100.5 },
    github_rate_limit_backoff_until: null,
    provider_backoff: [{ provider: 'codex', limit_key: 'codex', until: '2026-11-10T01:00:00.000Z' }],
    dispatch_deferrals: [{ at: '2026-11-10T00:00:00.500Z', reason: 'Workspace pool is full', issue_number: 7 }],
    dispatch_blocks: [{ reason: 'global_capacity', count: 3 }],
    protected_workspaces: [{ path: '/tmp/ws/_pool_1', issue_number: 9, reason: 'Preserving protected linked workspace' }],
  };
}

test('repo and orchestrator heartbeats round-trip atomically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-heartbeat-'));
  const repo = sampleRepoHeartbeat();
  await writeRepoHeartbeat(root, repo);
  assert.deepEqual(await readRepoHeartbeat(root), repo);
  assert.equal(repoHeartbeatPath(root), path.join(root, '.symphony', 'heartbeat.json'));

  const orchestrator: OrchestratorHeartbeat = {
    version: 1,
    pid: 456,
    started_at: '2026-11-10T00:00:00.000Z',
    updated_at: '2026-11-10T00:00:30.000Z',
    mode: 'config',
    source_path: path.join(root, 'symphony.config.yml'),
    polling_interval_ms: 30_000,
    max_concurrent_agents: 4,
    repo_ids: ['mdedit', 'symphony'],
    shutting_down: false,
  };
  await writeOrchestratorHeartbeat(root, orchestrator);
  assert.deepEqual(await readOrchestratorHeartbeat(root), orchestrator);
  assert.equal(orchestratorHeartbeatPath(root), path.join(root, '.symphony', 'heartbeat.json'));

  const leftovers = (await fs.readdir(path.join(root, '.symphony'))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('heartbeat reads return null for missing or corrupt files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-heartbeat-missing-'));
  assert.equal(await readRepoHeartbeat(root), null);
  assert.equal(await readOrchestratorHeartbeat(root), null);

  await fs.mkdir(path.join(root, '.symphony'), { recursive: true });
  await fs.writeFile(repoHeartbeatPath(root), '{not json', 'utf8');
  assert.equal(await readRepoHeartbeat(root), null);
  assert.equal(await readOrchestratorHeartbeat(root), null);

  await fs.writeFile(repoHeartbeatPath(root), JSON.stringify({ version: 2 }), 'utf8');
  assert.equal(await readRepoHeartbeat(root), null);
});

test('heartbeat writes never throw when the target is unwritable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-heartbeat-blocked-'));
  // A regular file where the `.symphony` directory should be makes mkdir fail.
  await fs.writeFile(path.join(root, '.symphony'), 'not a directory', 'utf8');
  await writeRepoHeartbeat(root, sampleRepoHeartbeat());
  assert.equal(await readRepoHeartbeat(root), null);
});

async function writeWorkflow(workspaceRoot: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-heartbeat-workflow-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  api_base_url: https://api.github.test
  active_states: [open]
  terminal_states: [closed]
  required_labels: [ready-for-agent]
workspace:
  root: ${workspaceRoot}
agent:
  max_concurrent_agents: 3
agents:
  default: codex
  providers:
    codex:
      command: "true"
---

Prompt body
`,
    'utf8',
  );
  return workflowPath;
}

async function runTickWithFetch(fetchImpl: typeof globalThis.fetch): Promise<RepoHeartbeat | null> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-heartbeat-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });
  try {
    await orchestrator.tickOnce();
    return await readRepoHeartbeat(workspaceRoot);
  } finally {
    await orchestrator.shutdown('test_complete');
    globalThis.fetch = originalFetch;
  }
}

test('a full tick writes a repo heartbeat with poll and capacity', async () => {
  const heartbeat = await runTickWithFetch(async (input, init) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') throw new Error(`Unexpected fetch ${method} ${String(input)}`);
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.ok(heartbeat);
  assert.equal(heartbeat.tick_outcome, 'ok');
  assert.equal(heartbeat.tick_skip_reason, null);
  assert.equal(heartbeat.repo_id, 'mdedit');
  assert.equal(heartbeat.owner, 'mangoappstudio');
  assert.equal(heartbeat.pid, process.pid);
  assert.ok(heartbeat.tick_finished_at);
  assert.ok(heartbeat.poll);
  // capacity_remaining depends on host free disk (0 when storage is blocked), so it is not pinned here.
  assert.deepEqual({ ...heartbeat.poll, capacity_remaining: null }, { candidate_count: 0, grooming_count: 0, active_count: 0, retry_count: 0, capacity_remaining: null });
  assert.deepEqual(heartbeat.capacity, { max_concurrent_agents: 3, running: 0 });
  assert.equal(typeof heartbeat.storage.blocked, 'boolean');
  assert.equal(heartbeat.github_rate_limit_backoff_until, null);
  assert.deepEqual(heartbeat.provider_backoff, []);
  assert.deepEqual(heartbeat.dispatch_deferrals, []);
});

test('a tick whose candidate fetch fails records a skipped heartbeat', async () => {
  const heartbeat = await runTickWithFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return new Response('{"message":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.ok(heartbeat);
  assert.equal(heartbeat.tick_outcome, 'skipped');
  assert.equal(heartbeat.tick_skip_reason, 'github_candidate_fetch_failed');
  assert.ok(heartbeat.tick_error);
  assert.equal(heartbeat.poll, null);
});
