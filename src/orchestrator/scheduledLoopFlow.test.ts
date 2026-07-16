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
