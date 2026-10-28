import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeServerConfig } from './loadServerConfig.js';
import { RepositorySync, syncPrimaryRepository } from './repositorySync.js';
import { MultiRepoOrchestrator } from '../orchestrator/multiRepoOrchestrator.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-primary-sync-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const checkout = path.join(root, 'checkout');
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'init', '-b', 'main', seed);
  for (const cwd of [seed]) {
    git(cwd, 'config', 'user.name', 'Test'); git(cwd, 'config', 'user.email', 'test@example.com');
  }
  await fs.writeFile(path.join(seed, 'WORKFLOW.md'), 'initial policy\n');
  await fs.writeFile(path.join(seed, '.gitignore'), 'private.txt\n');
  await fs.mkdir(path.join(seed, 'docs'));
  await fs.writeFile(path.join(seed, 'docs/notes.md'), 'notes');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'main');
  git(root, 'clone', remote, checkout);
  git(checkout, 'config', 'user.name', 'Test'); git(checkout, 'config', 'user.email', 'test@example.com');
  const advance = async (text: string) => {
    await fs.writeFile(path.join(seed, 'WORKFLOW.md'), text);
    git(seed, 'commit', '-am', 'update policy'); git(seed, 'push', 'origin', 'main');
  };
  const configPath = path.join(root, 'symphony.yml');
  const config = normalizeServerConfig({ repository_sync: { enabled: true }, repos: [{ id: 'app', workflow: path.join(checkout, 'WORKFLOW.md') }] }, configPath);
  return { root, remote, seed, checkout, advance, configPath, config };
}

test('fast-forwards a clean main checkout and picks up the remote workflow', async () => {
  const f = await fixture();
  await f.advance('new policy\n');
  assert.equal((await syncPrimaryRepository(f.checkout)).status, 'updated');
  assert.equal(await fs.readFile(path.join(f.checkout, 'WORKFLOW.md'), 'utf8'), 'new policy\n');
  assert.equal((await syncPrimaryRepository(f.checkout)).status, 'unchanged');
});

test('preserves dirty files and experimental branches', async () => {
  const f = await fixture(); await f.advance('remote policy');
  await fs.writeFile(path.join(f.checkout, 'untracked.txt'), 'unfinished');
  assert.equal((await syncPrimaryRepository(f.checkout)).reason, 'local-changes');
  await fs.unlink(path.join(f.checkout, 'untracked.txt'));
  await fs.writeFile(path.join(f.checkout, 'WORKFLOW.md'), 'local edits');
  assert.equal((await syncPrimaryRepository(f.checkout)).reason, 'local-changes');
  assert.equal(await fs.readFile(path.join(f.checkout, 'WORKFLOW.md'), 'utf8'), 'local edits');
  git(f.checkout, 'add', 'WORKFLOW.md'); git(f.checkout, 'commit', '-m', 'local work');
  git(f.checkout, 'checkout', '-b', 'experiment');
  assert.equal((await syncPrimaryRepository(f.checkout)).reason, 'not-on-main');
  assert.equal(git(f.checkout, 'branch', '--show-current'), 'experiment');
});

test('preserves local commits and in-progress Git operations', async () => {
  const f = await fixture(); await f.advance('remote policy');
  await fs.writeFile(path.join(f.checkout, 'local.txt'), 'local commit');
  git(f.checkout, 'add', 'local.txt'); git(f.checkout, 'commit', '-m', 'local');
  const head = git(f.checkout, 'rev-parse', 'HEAD');
  assert.equal((await syncPrimaryRepository(f.checkout)).reason, 'local-commits-or-divergence');
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), head);
  await fs.writeFile(path.join(f.checkout, '.git/MERGE_HEAD'), head);
  assert.equal((await syncPrimaryRepository(f.checkout)).reason, 'git-operation-in-progress');
});

test('never updates linked task worktrees or overwrites ignored local files', async () => {
  const f = await fixture();
  git(f.checkout, 'checkout', '-b', 'experiment');
  const linked = path.join(f.root, 'linked');
  git(f.checkout, 'worktree', 'add', linked, 'main');
  assert.equal((await syncPrimaryRepository(linked)).reason, 'linked-worktree');
  await fs.writeFile(path.join(f.seed, 'private.txt'), 'remote version');
  git(f.seed, 'add', '-f', 'private.txt'); git(f.seed, 'commit', '-m', 'track file'); git(f.seed, 'push', 'origin', 'main');
  git(f.checkout, 'worktree', 'remove', linked);
  git(f.checkout, 'checkout', 'main');
  await fs.writeFile(path.join(f.checkout, 'private.txt'), 'local private value');
  assert.equal((await syncPrimaryRepository(f.checkout)).status, 'failed');
  assert.equal(await fs.readFile(path.join(f.checkout, 'private.txt'), 'utf8'), 'local private value');
});

test('persists the twelve-hour cadence across restarts and skips disabled repositories', async () => {
  const f = await fixture();
  f.config.repos.push({ id: 'disabled', workflow: '/missing/WORKFLOW.md', max_concurrent_agents: null, enabled: false });
  let now = 1000;
  assert.equal((await new RepositorySync(f.configPath, () => now).run(f.config, new Set())).length, 1);
  await f.advance('new remote policy');
  now += 43_200_000 - 1;
  assert.deepEqual(await new RepositorySync(f.configPath, () => now).run(f.config, new Set()), []);
  now++;
  assert.equal((await new RepositorySync(f.configPath, () => now).run(f.config, new Set()))[0]?.status, 'updated');
});

test('deduplicates primary checkouts and skips them when any associated agent is active', async () => {
  const f = await fixture(); await f.advance('new policy');
  f.config.repos.push({ ...f.config.repos[0]!, id: 'nested', workflow: path.join(f.checkout, 'docs/WORKFLOW.md') });
  const results = await new RepositorySync(f.configPath).run(f.config, new Set(['nested']));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.reason, 'active-agents');
  assert.equal(await fs.readFile(path.join(f.checkout, 'WORKFLOW.md'), 'utf8'), 'initial policy\n');
});

test('one unavailable remote does not prevent syncing another repository', async () => {
  const first = await fixture(); const second = await fixture(); await second.advance('new policy');
  git(first.checkout, 'remote', 'set-url', 'origin', path.join(first.root, 'missing.git'));
  first.config.repos.push({ ...second.config.repos[0]!, id: 'second' });
  const results = await new RepositorySync(first.configPath).run(first.config, new Set());
  assert.deepEqual(results.map(result => result.status), ['failed', 'updated']);
});

test('sync is opt-in and never updates the running Symphony checkout', async () => {
  const f = await fixture(); await f.advance('remote policy');
  f.config.repository_sync.enabled = false;
  assert.deepEqual(await new RepositorySync(f.configPath).run(f.config, new Set()), []);
  assert.equal(await fs.readFile(path.join(f.checkout, 'WORKFLOW.md'), 'utf8'), 'initial policy\n');
  f.config.repository_sync.enabled = true;
  f.config.repos = [{ ...f.config.repos[0]!, workflow: path.resolve('WORKFLOW.md') }];
  assert.equal((await new RepositorySync(f.configPath).run(f.config, new Set()))[0]?.reason, 'symphony-checkout');
});

test('the multi-repo polling cycle syncs policies before ticking repository agents', async () => {
  const f = await fixture(); await f.advance('new policy');
  await fs.writeFile(f.configPath, JSON.stringify({ repository_sync: { enabled: true }, repos: [{ id: 'app', workflow: path.join(f.checkout, 'WORKFLOW.md') }] }));
  const original = Orchestrator.prototype.tickOnce;
  let ticks = 0;
  Orchestrator.prototype.tickOnce = async () => {
    assert.equal(await fs.readFile(path.join(f.checkout, 'WORKFLOW.md'), 'utf8'), 'new policy');
    ticks++;
  };
  const orchestrator = new MultiRepoOrchestrator({ configPath: f.configPath });
  try {
    await orchestrator.tickOnce();
    assert.equal(ticks, 1);
  } finally {
    Orchestrator.prototype.tickOnce = original;
    await orchestrator.shutdown('test');
  }
});
