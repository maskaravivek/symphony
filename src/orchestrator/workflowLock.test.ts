import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireWorkflowLock } from './workflowLock.js';

test('workflow lock blocks a second live owner until released', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-workflow-lock-'));
  const first = await acquireWorkflowLock({
    workspaceRoot,
    repoId: 'mdedit',
    owner: 'mangoappstudio',
    repo: 'mdedit',
    workflowPath: '/tmp/WORKFLOW.md',
  });
  assert.equal(first.acquired, true);

  const second = await acquireWorkflowLock({
    workspaceRoot,
    repoId: 'mdedit',
    owner: 'mangoappstudio',
    repo: 'mdedit',
    workflowPath: '/tmp/WORKFLOW.md',
  });
  assert.equal(second.acquired, false);
  assert.equal(second.owner?.pid, process.pid);

  if (first.acquired) await first.lock.release();

  const third = await acquireWorkflowLock({
    workspaceRoot,
    repoId: 'mdedit',
    owner: 'mangoappstudio',
    repo: 'mdedit',
    workflowPath: '/tmp/WORKFLOW.md',
  });
  assert.equal(third.acquired, true);
  if (third.acquired) await third.lock.release();
});

test('workflow lock recovers stale owners', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-stale-workflow-lock-'));
  const lockPath = path.join(workspaceRoot, '.symphony', 'orchestrator.lock');
  await fs.mkdir(lockPath, { recursive: true });
  await fs.writeFile(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({
      pid: 999999999,
      token: 'stale',
      hostname: 'old-host',
      repo_id: 'mdedit',
      owner: 'mangoappstudio',
      repo: 'mdedit',
      workflow_path: '/tmp/WORKFLOW.md',
      acquired_at: '2026-07-01T00:00:00.000Z',
    }),
    'utf8',
  );

  const acquired = await acquireWorkflowLock({
    workspaceRoot,
    repoId: 'mdedit',
    owner: 'mangoappstudio',
    repo: 'mdedit',
    workflowPath: '/tmp/WORKFLOW.md',
  });

  assert.equal(acquired.acquired, true);
  if (acquired.acquired) {
    assert.equal(acquired.lock.owner.pid, process.pid);
    await acquired.lock.release();
  }
});
