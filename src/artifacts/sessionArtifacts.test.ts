import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pruneSessionArtifacts } from './sessionArtifacts.js';

test('retains the active session and at most fifty recent session directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-artifacts-'));
  for (let index = 0; index < 53; index += 1) {
    const dir = path.join(root, `2026-07-11T00-00-${String(index).padStart(2, '0')}-1-session-${index}`);
    await fs.mkdir(dir);
    const at = new Date(Date.now() - index * 1000);
    await fs.utimes(dir, at, at);
  }
  const active = path.join(root, '2026-07-11T00-00-52-1-session-52');
  await pruneSessionArtifacts(root, { activeDir: active, maxSessions: 50, maxAgeDays: 30 });
  const remaining = await fs.readdir(root);
  assert.equal(remaining.length, 50);
  assert.equal(remaining.includes(path.basename(active)), true);
});

test('byte budget keeps active evidence and prunes other issues in a shared pool', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-artifact-budget-'));
  for (const name of ['active', 'other']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'output'), 'large evidence');
  }
  await pruneSessionArtifacts(root, { activeDir: path.join(root, 'active'), maxBytes: 1 });
  assert.deepEqual(await fs.readdir(root), ['active']);
});
