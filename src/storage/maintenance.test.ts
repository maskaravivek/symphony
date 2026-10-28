import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { maintainStorage, pruneOwnedDirectory, storageAvailable } from './maintenance.js';
import { DAY } from './policy.js';
import type { WorkspaceConfig } from '../workflow/types.js';
import type { RunState } from '../status/runState.js';
import { writeRunState } from '../status/runState.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config: WorkspaceConfig = { root: path.join(root, 'workspaces'), clean_on_terminal: true, strategy: { implementation: 'pooled_isolated', planning: 'durable_issue_workspace', epic: { stacked: 'durable_epic_workspace', independent: 'pooled_isolated' } } };
  await fs.mkdir(config.root);
  return { root, config };
}
async function oldFile(file: string, content = 'old') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  const old = new Date(Date.now() - 40 * DAY);
  await fs.utimes(file, old, old);
}
async function checkout(root: string, status: RunState['status'] = 'completed') {
  const workspace = path.join(root, '_pool_1');
  await fs.mkdir(workspace);
  git(workspace, 'init', '-b', 'main');
  git(workspace, 'config', 'user.email', 'test@example.com');
  git(workspace, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(workspace, '.gitignore'), '.symphony/\nnode_modules/\nprivate/\n');
  git(workspace, 'add', '.'); git(workspace, 'commit', '-m', 'initial');
  git(workspace, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await writeRunState(workspace, { workspace_path: workspace, status, updated_at: new Date(Date.now() - 10 * DAY).toISOString(), worker_pid: null } as RunState);
  return workspace;
}

test('daily cadence survives restarts, skips busy repositories, and bounds archives', async t => {
  const { config } = await fixture(t);
  const file = path.join(config.root, '_archives', 'old');
  await oldFile(file);
  await maintainStorage(config, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  await maintainStorage(config, false);
  await assert.rejects(fs.access(file));
  await oldFile(file);
  await maintainStorage(config, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  await maintainStorage(config, false, Date.now() + DAY + 100);
  await assert.rejects(fs.access(file));
});

test('deletes only clean stale checkouts with all commits backed by remote refs and archives state', async t => {
  const { config } = await fixture(t);
  const workspace = await checkout(config.root);
  await fs.mkdir(path.join(workspace, 'node_modules'));
  await fs.writeFile(path.join(workspace, 'node_modules', 'generated'), 'dependency');
  await maintainStorage(config, false);
  await assert.rejects(fs.access(workspace));
  const archives = await fs.readdir(path.join(config.root, '_archives'));
  assert.equal(archives.length, 1);
  const state = JSON.parse(await fs.readFile(path.join(config.root, '_archives', archives[0]!, 'run.json'), 'utf8'));
  assert.equal(state.status, 'completed');
});

for (const protection of ['paused', 'retry-wait', 'dirty', 'unpushed', 'stash', 'ignored-private', 'unknown', 'live-worker', 'symlink'] as const) {
  test(`preserves ${protection} workspaces`, async t => {
    const { config, root } = await fixture(t);
    const workspace = await checkout(config.root, protection === 'paused' || protection === 'retry-wait' ? protection : 'completed');
    if (protection === 'dirty') await fs.writeFile(path.join(workspace, 'new.txt'), 'unfinished');
    if (protection === 'unpushed') {
      await fs.writeFile(path.join(workspace, 'new.txt'), 'work');
      git(workspace, 'add', '.'); git(workspace, 'commit', '-m', 'local');
    }
    if (protection === 'stash') {
      await fs.writeFile(path.join(workspace, '.gitignore'), 'local');
      git(workspace, 'stash', 'push');
    }
    if (protection === 'ignored-private') await oldFile(path.join(workspace, 'private', 'secret'));
    if (protection === 'unknown') await fs.unlink(path.join(workspace, '.symphony', 'run.json'));
    if (protection === 'live-worker') {
      const statePath = path.join(workspace, '.symphony', 'run.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      await fs.writeFile(statePath, JSON.stringify({ ...state, worker_pid: process.pid }));
    }
    if (protection === 'symlink') {
      const outside = path.join(root, 'outside');
      await fs.rename(workspace, outside);
      await fs.symlink(outside, workspace);
    }
    await maintainStorage(config, false);
    await fs.access(path.join(workspace, '.git'));
  });
}

test('retention enforces byte limits and never follows artifact symlinks', async t => {
  const { root } = await fixture(t);
  const artifacts = path.join(root, 'artifacts');
  const outside = path.join(root, 'outside');
  await fs.mkdir(artifacts); await oldFile(outside, 'protected');
  await fs.symlink(outside, path.join(artifacts, 'link'));
  await fs.writeFile(path.join(artifacts, 'too-big'), 'oversized');
  assert.equal(await pruneOwnedDirectory(artifacts, { cutoff: 0, maxBytes: 1 }), 9);
  assert.equal(await fs.readFile(outside, 'utf8'), 'protected');
  assert.equal((await fs.lstat(path.join(artifacts, 'link'))).isSymbolicLink(), true);
});

test('cache cleanup is explicitly scoped and preserves Git mirrors, lockfiles and unknown data', async t => {
  const { root, config } = await fixture(t);
  const cache = path.join(root, 'cache');
  config.storage_maintenance = { cache_root: cache };
  const hash = 'a'.repeat(64);
  await oldFile(path.join(cache, 'repo.git', 'objects', 'object'));
  await oldFile(path.join(cache, 'node_modules', hash, 'dependency'));
  const old = new Date(Date.now() - 40 * DAY);
  await fs.utimes(path.join(cache, 'node_modules', hash), old, old);
  await oldFile(path.join(cache, 'node_modules', 'unknown', 'private'));
  await maintainStorage(config, false);
  await assert.rejects(fs.access(path.join(cache, 'node_modules', hash)));
  await fs.access(path.join(cache, 'repo.git', 'objects', 'object'));
  await fs.access(path.join(cache, 'node_modules', 'unknown', 'private'));
});

test('free-space guard fails closed for unavailable filesystems or insufficient space', async t => {
  const { root } = await fixture(t);
  assert.equal(await storageAvailable(root, Number.MAX_SAFE_INTEGER), false);
  assert.equal(await storageAvailable(path.join(root, 'missing'), 1), false);
  assert.equal(await storageAvailable(root, Number.MIN_VALUE), true);
});
