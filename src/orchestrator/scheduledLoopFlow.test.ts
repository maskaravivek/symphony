import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from './orchestrator.js';

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}

test('runs one due scheduled loop and does not duplicate it after restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-loop-flow-'));
  const workflowPath = path.join(root, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  owner: example
  repo: app
  token: token
  api_base_url: https://api.github.test
  required_labels: [ready-for-agent]
workspace:
  root: ${path.join(root, 'workspaces')}
loops:
  - id: quality
    interval_ms: 86400000
    prompt: Run one quality pass.
agents:
  default: codex
  providers:
    codex:
      command: bash -lc 'printf "%s" "$SYMPHONY_LAST_MESSAGE_PATH" > loop-last-message-path.txt; echo run >> loop-runs.txt; echo done > "$SYMPHONY_LAST_MESSAGE_PATH"'
---

Issue prompt.
`,
    'utf8',
  );
  const loopWorkspace = path.join(root, 'workspaces', '_loops', 'quality');
  const marker = path.join(loopWorkspace, 'loop-runs.txt');
  const observedLastMessagePath = path.join(loopWorkspace, 'loop-last-message-path.txt');
  const expectedLastMessagePath = path.join(loopWorkspace, '.symphony', 'last_message.md');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const first = new Orchestrator({ workflowPath, repoId: 'app' });
    await first.tickOnce({ maxNewDispatches: 1 });
    await waitForFile(marker);
    await first.shutdown('test');

    const second = new Orchestrator({ workflowPath, repoId: 'app' });
    await second.tickOnce({ maxNewDispatches: 1 });
    await second.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal((await fs.readFile(marker, 'utf8')).trim(), 'run');
  assert.equal(await fs.readFile(observedLastMessagePath, 'utf8'), expectedLastMessagePath);
  assert.equal((await fs.readFile(expectedLastMessagePath, 'utf8')).trim(), 'done');
});

test('disk pressure blocks dispatch, still runs maintenance, and resumes after recovery', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-storage-flow-'));
  const workflowPath = path.join(root, 'WORKFLOW.md');
  const workspaceRoot = path.join(root, 'workspaces');
  const workflow = (minimum: number) => `---
tracker:
  owner: example
  repo: app
  token: token
  api_base_url: https://api.github.test
workspace:
  root: ${workspaceRoot}
  storage_maintenance:
    min_free_gib: ${minimum}
loops:
  - id: quality
    interval_ms: 86400000
    prompt: One quality pass.
agents:
  providers:
    codex:
      command: bash -lc 'echo run > marker'
---
Prompt.
`;
  await fs.writeFile(workflowPath, workflow(Number.MAX_SAFE_INTEGER));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { headers: { 'content-type': 'application/json' } });
  const orchestrator = new Orchestrator({ workflowPath });
  t.after(async () => {
    globalThis.fetch = original;
    await orchestrator.shutdown('test');
    await fs.rm(root, { recursive: true, force: true });
  });
  await orchestrator.tickOnce();
  await fs.access(path.join(workspaceRoot, '.symphony', 'storage-maintenance.json'));
  const status = () => fs.readFile(path.join(workspaceRoot, '.symphony', 'storage-status.json'), 'utf8').then(JSON.parse);
  assert.equal((await status()).blocked, true);
  const marker = path.join(workspaceRoot, '_loops', 'quality', 'marker');
  await assert.rejects(fs.access(marker));
  await fs.writeFile(workflowPath, workflow(0.001));
  await orchestrator.tickOnce();
  await waitForFile(marker);
  assert.equal((await status()).blocked, false);
});
