import type { Issue } from '../domain/issue.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureLinkedWorktree, ownsLinkedWorktree, removeLinkedWorktree } from './linkedWorktrees.js';
import { WorkspaceManager } from './workspaceManager.js';
import { disposableCheckout } from '../storage/checkoutSafety.js';
import { maintainStorage } from '../storage/maintenance.js';
import type { WorkspaceConfig } from '../workflow/types.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-linked-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), remote = path.join(root, 'remote.git');
  await fs.mkdir(source); await git(source, 'init', '-q', '-b', 'main');
  await git(source, 'config', 'user.email', 'test@example.com'); await git(source, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(source, 'source.txt'), 'source');
  await fs.writeFile(path.join(source, '.gitignore'), 'node_modules/\n.next/\n.symphony/\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'initial');
  await git(root, 'clone', '--bare', source, remote); await git(source, 'remote', 'add', 'origin', remote);
  const config: WorkspaceConfig = { root: path.join(root, 'workspaces'), clean_on_terminal: true,
    checkout: { kind: 'linked_worktree', source, base_branch: 'main' },
    strategy: { implementation: 'pooled_isolated', planning: 'durable_issue_workspace', epic: { stacked: 'durable_epic_workspace', independent: 'pooled_isolated' } },
    storage_maintenance: { warm_pool_slots: 1, min_free_gib: 0.001 } };
  return { root, source, config, slot: path.join(config.root, '_pool_1') };
}

test('parallel linked slots share Git objects and isolate edits without touching the primary checkout', async t => {
  const { config, source, slot } = await fixture(t), second = path.join(config.root, '_pool_2');
  await Promise.all([ensureLinkedWorktree(config, slot), ensureLinkedWorktree(config, second)]);
  assert.equal(await git(slot, 'rev-parse', '--git-common-dir'), await git(second, 'rev-parse', '--git-common-dir'));
  assert.ok((await fs.stat(path.join(slot, '.git'))).isFile());
  await fs.writeFile(path.join(slot, 'source.txt'), 'agent edit');
  assert.equal(await fs.readFile(path.join(second, 'source.txt'), 'utf8'), 'source');
  assert.equal(await fs.readFile(path.join(source, 'source.txt'), 'utf8'), 'source');
  assert.equal(await ownsLinkedWorktree(config.root, slot), true);
  await assert.rejects(removeLinkedWorktree(config.root, slot), /protected/);
  await assert.rejects(ensureLinkedWorktree(config, slot), /protected/);
  await ensureLinkedWorktree(config, slot, undefined, true);
  assert.equal(await fs.readFile(path.join(slot, 'source.txt'), 'utf8'), 'agent edit');
});

test('terminal release preserves a warm linked slot, dependencies and install stamp; explicit eviction unregisters it', async t => {
  const { config, slot } = await fixture(t); await ensureLinkedWorktree(config, slot);
  await fs.mkdir(path.join(slot, 'node_modules')); await fs.writeFile(path.join(slot, 'node_modules', 'cached'), 'keep');
  await fs.mkdir(path.join(slot, '.symphony')); await fs.writeFile(path.join(slot, '.symphony', 'dependencies.json'), '{"fingerprint":"valid"}');
  await fs.writeFile(path.join(slot, '.symphony', 'state.json'), 'old state');
  const manager = new WorkspaceManager(config);
  await manager.cleanWorkspace(slot);
  assert.equal(await disposableCheckout(slot, { linkedRoot: config.root }), true);
  assert.equal(await fs.readFile(path.join(slot, 'node_modules', 'cached'), 'utf8'), 'keep');
  assert.equal(JSON.parse(await fs.readFile(path.join(slot, '.symphony', 'dependencies.json'), 'utf8')).fingerprint, 'valid');
  const next: Issue = { id: '2', identifier: 'example/app#2', number: 2, title: 'Next task', description: '', priority: null, url: null,
    state: 'open', labels: [], assignees: [], milestone: null, blocked_by: [], pull_requests: [], workflow_state: null,
    branch_name: 'symphony-2', created_at: null, updated_at: null, ready_for_agent_labeled_at: null };
  assert.equal((await manager.ensureWorkspace(next, { strategy: 'pooled_isolated' })).workspace_path, slot);
  await manager.cleanWorkspace(slot, { evict: true });
  await assert.rejects(fs.access(slot));
  assert.ok(!(await git(path.join(config.root, '.symphony', 'repository.git'), 'worktree', 'list', '--porcelain')).includes(slot));
});

test('unpublished work and foreign linked worktrees never become disposable', async t => {
  const { config, slot, source, root } = await fixture(t); await ensureLinkedWorktree(config, slot);
  await git(slot, 'config', 'user.email', 'test@example.com'); await git(slot, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(slot, 'new.txt'), 'unpublished'); await git(slot, 'add', '.'); await git(slot, 'commit', '-qm', 'local only');
  assert.equal(await disposableCheckout(slot, { linkedRoot: config.root }), false);
  const foreign = path.join(root, 'foreign'); await git(source, 'worktree', 'add', '--detach', foreign, 'HEAD');
  assert.equal(await ownsLinkedWorktree(config.root, foreign), false);
  assert.equal(await disposableCheckout(foreign, { linkedRoot: config.root }), false);
});

test('maintenance retains warm dependencies, prunes stale output and unregisters only excess idle slots', async t => {
  const { config, slot } = await fixture(t), second = path.join(config.root, '_pool_2');
  for (const directory of [slot, second]) {
    await ensureLinkedWorktree(config, directory);
    await fs.mkdir(path.join(directory, 'node_modules')); await fs.writeFile(path.join(directory, 'node_modules', 'keep'), 'dependency');
    await fs.mkdir(path.join(directory, '.next')); await fs.writeFile(path.join(directory, '.next', 'old'), 'cache');
    const old = new Date(Date.now() - 40 * 86400000);
    await fs.utimes(path.join(directory, '.next'), old, old); await fs.utimes(directory, old, old);
  }
  await maintainStorage(config, false);
  assert.equal(await fs.readFile(path.join(slot, 'node_modules', 'keep'), 'utf8'), 'dependency');
  await assert.rejects(fs.access(path.join(slot, '.next')));
  await assert.rejects(fs.access(second));
  assert.ok(!(await git(path.join(config.root, '.symphony', 'repository.git'), 'worktree', 'list', '--porcelain')).includes(second));
});

test('clean legacy clones migrate without copying or discarding dependency installations', async t => {
  const { config, root, slot } = await fixture(t);
  await fs.mkdir(config.root, { recursive: true });
  await git(config.root, 'clone', path.join(root, 'remote.git'), slot);
  // The local source is our remote in this fixture, so main is remotely accounted for.
  await fs.mkdir(path.join(slot, 'node_modules')); await fs.writeFile(path.join(slot, 'node_modules', 'keep'), 'installed');
  await fs.mkdir(path.join(slot, '.symphony')); await fs.writeFile(path.join(slot, '.symphony', 'dependencies.json'), 'stamp');
  const before = await fs.stat(path.join(slot, 'node_modules', 'keep'));
  await ensureLinkedWorktree(config, slot);
  assert.equal(await ownsLinkedWorktree(config.root, slot), true);
  assert.equal((await fs.stat(path.join(slot, 'node_modules', 'keep'))).ino, before.ino);
  assert.equal(await fs.readFile(path.join(slot, '.symphony', 'dependencies.json'), 'utf8'), 'stamp');
});
