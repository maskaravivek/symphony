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
  // Real repositories can track verification configuration inside the otherwise ignored artifact directory.
  await fs.mkdir(path.join(source, '.symphony'));
  await fs.writeFile(path.join(source, '.symphony', 'verification.json'), '{}');
  await git(source, 'add', '-f', '.symphony/verification.json');
  await git(source, 'commit', '-qm', 'tracked verification configuration');
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
  await fs.mkdir(path.join(slot, '.symphony'), { recursive: true }); await fs.writeFile(path.join(slot, '.symphony', 'dependencies.json'), '{"fingerprint":"valid"}');
  await fs.writeFile(path.join(slot, '.symphony', 'state.json'), 'old state');
  const manager = new WorkspaceManager(config);
  await manager.cleanWorkspace(slot);
  assert.equal(await disposableCheckout(slot, { linkedRoot: config.root }), true);
  assert.equal(await fs.readFile(path.join(slot, '.symphony', 'verification.json'), 'utf8'), '{}');
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
    const exclude = path.join(config.root, '.symphony', 'repository.git', 'info', 'exclude');
    await fs.appendFile(exclude, '\n.open-next/\ntest-results/\n*.tsbuildinfo\n.eslintcache\n');
    const old = new Date(Date.now() - 40 * 86400000);
    for (const name of ['.next', '.open-next', 'test-results']) {
      await fs.mkdir(path.join(directory, name)); await fs.writeFile(path.join(directory, name, 'old'), 'cache');
      await fs.utimes(path.join(directory, name), old, old);
    }
    for (const name of ['tsconfig.tsbuildinfo', '.eslintcache']) {
      await fs.writeFile(path.join(directory, name), 'generated cache');
      await fs.utimes(path.join(directory, name), old, old);
    }
    await fs.utimes(directory, old, old);
  }
  await maintainStorage(config, false);
  assert.equal(await fs.readFile(path.join(slot, 'node_modules', 'keep'), 'utf8'), 'dependency');
  await assert.rejects(fs.access(path.join(slot, '.next')));
  await assert.rejects(fs.access(path.join(slot, '.open-next')));
  await assert.rejects(fs.access(path.join(slot, 'test-results')));
  await assert.rejects(fs.access(path.join(slot, 'tsconfig.tsbuildinfo')));
  await assert.rejects(fs.access(path.join(slot, '.eslintcache')));
  await assert.rejects(fs.access(second));
  assert.ok(!(await git(path.join(config.root, '.symphony', 'repository.git'), 'worktree', 'list', '--porcelain')).includes(second));
});

test('clean legacy clones migrate without copying or discarding dependency installations', async t => {
  const { config, root, slot } = await fixture(t);
  await fs.mkdir(config.root, { recursive: true });
  await git(config.root, 'clone', path.join(root, 'remote.git'), slot);
  // The local source is our remote in this fixture, so main is remotely accounted for.
  await fs.mkdir(path.join(slot, 'node_modules')); await fs.writeFile(path.join(slot, 'node_modules', 'keep'), 'installed');
  await fs.mkdir(path.join(slot, '.symphony'), { recursive: true }); await fs.writeFile(path.join(slot, '.symphony', 'dependencies.json'), 'stamp');
  const before = await fs.stat(path.join(slot, 'node_modules', 'keep'));
  await ensureLinkedWorktree(config, slot);
  assert.equal(await ownsLinkedWorktree(config.root, slot), true);
  assert.equal((await fs.stat(path.join(slot, 'node_modules', 'keep'))).ino, before.ino);
  assert.equal(await fs.readFile(path.join(slot, '.symphony', 'dependencies.json'), 'utf8'), 'stamp');
});


test('task checkout releases a branch retained by an idle warm slot but protects unfinished work', async t => {
  const { config, slot } = await fixture(t), second = path.join(config.root, '_pool_2');
  await ensureLinkedWorktree(config, slot);
  await ensureLinkedWorktree(config, second);
  await git(slot, 'checkout', '-b', 'symphony-task');
  const manager = new WorkspaceManager(config);
  await fs.mkdir(path.join(slot, '.symphony'), { recursive: true });
  for (const status of ['agent-running', 'paused', 'retry-wait']) {
    await fs.writeFile(path.join(slot, '.symphony', 'run.json'), JSON.stringify({ status }));
    await assert.rejects(manager.prepareCheckout(second, undefined, 'symphony-task'), /protected/);
    assert.equal(await git(slot, 'branch', '--show-current'), 'symphony-task');
  }
  await fs.rm(path.join(slot, '.symphony', 'run.json'));
  await manager.prepareCheckout(second, undefined, 'symphony-task');
  await git(second, 'checkout', '-B', 'symphony-task');
  assert.equal(await git(slot, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  await fs.writeFile(path.join(second, 'source.txt'), 'unfinished');
  await assert.rejects(manager.prepareCheckout(slot, undefined, 'symphony-task'), /protected/);
  assert.equal(await git(second, 'branch', '--show-current'), 'symphony-task');
  assert.equal(await fs.readFile(path.join(second, 'source.txt'), 'utf8'), 'unfinished');
});


test('terminal evidence and ignored build outputs release a warm slot without discarding other edits', async t => {
  const { config, slot } = await fixture(t);
  await ensureLinkedWorktree(config, slot);
  await git(slot, 'config', 'user.email', 'test@example.com');
  await git(slot, 'config', 'user.name', 'Test');
  const exclude = path.join(config.root, '.symphony', 'repository.git', 'info', 'exclude');
  await fs.appendFile(exclude, '\n.open-next/\ntest-results/\nyarn-error.log\nprivate-backup.txt\n');
  for (const name of ['.open-next', 'test-results']) {
    await fs.mkdir(path.join(slot, name)); await fs.writeFile(path.join(slot, name, 'generated'), 'output');
  }
  await fs.writeFile(path.join(slot, 'yarn-error.log'), 'generated error log');
  const artifacts = path.join(slot, '.symphony', 'runs', 'session');
  await fs.mkdir(artifacts, {recursive:true});
  const evidence = JSON.stringify({version:1, head_sha:await git(slot, 'rev-parse', 'HEAD'), evidence:[]});
  await fs.writeFile(path.join(slot, '.symphony', 'verification.json'), evidence);
  await fs.writeFile(path.join(artifacts, 'verification.json'), evidence);
  await fs.writeFile(path.join(slot, '.symphony', 'run.json'), JSON.stringify({status:'completed', workspace_path:slot, session_artifact_dir:artifacts}));
  assert.equal(await disposableCheckout(slot, {linkedRoot:config.root}), true);
  await fs.writeFile(path.join(slot, 'source.txt'), 'unfinished edit');
  assert.equal(await disposableCheckout(slot, {linkedRoot:config.root}), false);
  await git(slot, 'restore', '--', 'source.txt');
  await fs.writeFile(path.join(slot, 'private-backup.txt'), 'preserve');
  assert.equal(await disposableCheckout(slot, {linkedRoot:config.root}), false);
  await fs.rm(path.join(slot, 'private-backup.txt'));
  await fs.writeFile(path.join(slot, '.symphony', 'verification.json'), 'unarchived evidence');
  assert.equal(await disposableCheckout(slot, {linkedRoot:config.root}), false);
  await fs.writeFile(path.join(slot, '.symphony', 'verification.json'), evidence);
  await new WorkspaceManager(config).cleanWorkspace(slot);
  assert.equal(await git(slot, 'status', '--porcelain'), '');
  const archived = await fs.readdir(path.join(config.root, '_archives'));
  assert.equal(await fs.readFile(path.join(config.root, '_archives', archived[0]!, 'verification.json'), 'utf8'), evidence);
  assert.equal(await fs.readFile(path.join(slot, '.symphony', 'verification.json'), 'utf8'), '{}');
});


test('ignored cache files and unstaged tracked build caches do not block cleanup, but staged work does', async t => {
  const { config, source, slot, root } = await fixture(t);
  await fs.writeFile(path.join(source, 'tsconfig.tsbuildinfo'), 'original cache');
  await git(source, 'add', 'tsconfig.tsbuildinfo'); await git(source, 'commit', '-qm', 'tracked cache fixture');
  await git(source, 'push', path.join(root, 'remote.git'), 'main');
  await ensureLinkedWorktree(config, slot);
  const exclude = path.join(config.root, '.symphony', 'repository.git', 'info', 'exclude');
  await fs.appendFile(exclude, '\n*.tsbuildinfo\n.eslintcache\n.stylelintcache\n.DS_Store\nnpm-debug.log\n.env.local\n');
  for (const name of ['extra.tsbuildinfo', '.eslintcache', '.stylelintcache', '.DS_Store', 'npm-debug.log']) await fs.writeFile(path.join(slot, name), 'generated');
  await fs.writeFile(path.join(slot, 'tsconfig.tsbuildinfo'), 'rebuilt');
  assert.equal(await disposableCheckout(slot, {linkedRoot:config.root}), true);
  await git(slot, 'add', 'tsconfig.tsbuildinfo');
  assert.equal(await disposableCheckout(slot, {linkedRoot:config.root}), false);
  await git(slot, 'restore', '--staged', 'tsconfig.tsbuildinfo');
  await fs.writeFile(path.join(slot, '.env.local'), 'CUSTOM_SETTING=preserve');
  assert.equal(await disposableCheckout(slot, {linkedRoot:config.root}), false);
  await fs.rm(path.join(slot, '.env.local'));
  await fs.writeFile(path.join(slot, 'source.txt'), 'source edit');
  assert.equal(await disposableCheckout(slot, {linkedRoot:config.root}), false);
  await git(slot, 'restore', 'source.txt');
  await new WorkspaceManager(config).cleanWorkspace(slot);
  assert.equal(await git(slot, 'status', '--porcelain'), '');
  assert.equal(await fs.readFile(path.join(slot, 'tsconfig.tsbuildinfo'), 'utf8'), 'original cache');
  assert.equal(await fs.readFile(path.join(slot, 'extra.tsbuildinfo'), 'utf8'), 'generated');
});


test('PR feedback prefers its original linked worktree and falls back to a warm slot without disturbing edits', async t => {
  const {config, slot} = await fixture(t), original = path.join(config.root, '_pool_2');
  await ensureLinkedWorktree(config, slot); await ensureLinkedWorktree(config, original);
  await git(original, 'checkout', '-b', 'symphony-17-change');
  await fs.mkdir(path.join(original, 'node_modules')); await fs.writeFile(path.join(original, 'node_modules', 'warm'), 'installed');
  const issue: Issue = {id:'42',number:42,identifier:'example/app#42',title:'Review',description:'',priority:null,url:null,state:'open',labels:[],assignees:[],milestone:null,blocked_by:[],pull_requests:[],workflow_state:null,branch_name:'symphony-17-change',created_at:null,updated_at:null,ready_for_agent_labeled_at:null};
  const manager = new WorkspaceManager(config, 2);
  const chosen = await manager.ensureWorkspace(issue, {strategy:'pooled_isolated', preferredBranch:'symphony-17-change', originatingIssueNumber:17});
  assert.equal(chosen.workspace_path, original);
  assert.equal(await fs.readFile(path.join(original, 'node_modules', 'warm'), 'utf8'), 'installed');
  await fs.writeFile(path.join(original, 'source.txt'), 'keep unfinished work');
  const fallback = await manager.ensureWorkspace(issue, {strategy:'pooled_isolated', preferredBranch:'symphony-17-change', originatingIssueNumber:17});
  assert.equal(fallback.workspace_path, slot);
  assert.equal(await fs.readFile(path.join(original, 'source.txt'), 'utf8'), 'keep unfinished work');
  await fs.mkdir(path.join(original, '.symphony'), {recursive:true});
  await fs.writeFile(path.join(original, '.symphony', 'run.json'), JSON.stringify({issue_id:'17', issue_number:17,status:'agent-running'}));
  await assert.rejects(manager.ensureWorkspace(issue, {strategy:'pooled_isolated', preferredBranch:'symphony-17-change', originatingIssueNumber:17}), /active|reserved/);
});


test('adopted durable PR workspaces stay warm and paused feedback resumes local edits', async t => {
  const {config} = await fixture(t), original = path.join(config.root, 'example_app_17');
  await ensureLinkedWorktree(config, original);
  await git(original, 'checkout', '-b', 'symphony-17-change');
  await fs.mkdir(path.join(original, 'node_modules'));
  await fs.writeFile(path.join(original, 'node_modules', 'warm'), 'installed');
  await fs.mkdir(path.join(original, '.symphony'), {recursive:true});
  const statePath = path.join(original, '.symphony', 'run.json');
  await fs.writeFile(statePath, JSON.stringify({issue_id:'17',issue_number:17,status:'completed',workspace_strategy:'durable_issue_workspace'}));
  const issue: Issue = {id:'42',number:42,identifier:'example/app#42',title:'Review',description:'',priority:null,url:null,state:'open',labels:[],assignees:[],milestone:null,blocked_by:[],pull_requests:[],workflow_state:null,branch_name:'symphony-17-change',created_at:null,updated_at:null,ready_for_agent_labeled_at:null};
  const manager = new WorkspaceManager(config);
  assert.equal((await manager.ensureWorkspace(issue, {strategy:'pooled_isolated',preferredBranch:'symphony-17-change',originatingIssueNumber:17})).workspace_path, original);
  await assert.rejects(fs.access(statePath)); // Original run evidence was archived before adoption.
  await fs.writeFile(statePath, JSON.stringify({issue_id:'42',issue_number:42,status:'completed',workspace_strategy:'pooled_isolated'}));
  await manager.cleanWorkspace(original);
  assert.equal(await fs.readFile(path.join(original, 'node_modules', 'warm'), 'utf8'), 'installed');
  await fs.writeFile(statePath, JSON.stringify({issue_id:'42',issue_number:42,status:'paused',workspace_strategy:'pooled_isolated'}));
  await fs.writeFile(path.join(original, 'source.txt'), 'partial review fix');
  assert.equal((await manager.ensureWorkspace(issue, {strategy:'pooled_isolated',preferredBranch:'symphony-17-change',originatingIssueNumber:17})).workspace_path, original);
  assert.equal(await fs.readFile(path.join(original, 'source.txt'), 'utf8'), 'partial review fix');
});
