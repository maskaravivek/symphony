import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceConfig } from '../workflow/types.js';
import { safeStoragePath } from '../storage/paths.js';
import { DispatchDeferredError } from '../storage/policy.js';
import { disposableCheckout } from '../storage/checkoutSafety.js';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[], signal?: AbortSignal) => (await exec('git', args, { cwd, signal, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
const queues = new Map<string, Promise<unknown>>();
const mirrorFor = (root: string) => path.join(root, '.symphony', 'repository.git');
const markerName = 'symphony-workspace.json';

/** Only our own mirror and per-worktree ownership record grant cleanup/reuse authority. */
export async function ownsLinkedWorktree(root: string, workspace: string): Promise<boolean> {
  try {
    if (!(await safeStoragePath(workspace))) return false;
    const entry = await fs.lstat(path.join(workspace, '.git'));
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    const mirror = await fs.realpath(mirrorFor(root));
    if (await fs.realpath(await git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== mirror) return false;
    const gitDir = await git(workspace, ['rev-parse', '--absolute-git-dir']);
    const realDir = await fs.realpath(gitDir);
    if (!realDir.startsWith(`${mirror}${path.sep}worktrees${path.sep}`)) return false;
    const record = JSON.parse(await fs.readFile(path.join(realDir, markerName), 'utf8'));
    return record.version === 1 && record.root === await fs.realpath(root) && record.workspace === await fs.realpath(workspace);
  } catch { return false; }
}

/** Serializes mirror creation/fetch/worktree registration within the workflow lease. */
export async function ensureLinkedWorktree(config: WorkspaceConfig, workspace: string, signal?: AbortSignal, preserveWork = false): Promise<void> {
  if (!config.checkout) return;
  const previous = queues.get(config.root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => prepare(config, workspace, signal, preserveWork));
  queues.set(config.root, next);
  try { await next; } finally { if (queues.get(config.root) === next) queues.delete(config.root); }
}

async function prepare(config: WorkspaceConfig, workspace: string, signal?: AbortSignal, preserveWork = false): Promise<void> {
  signal?.throwIfAborted();
  const checkout = config.checkout!;
  await fs.mkdir(workspace, { recursive: true });
  if (!(await safeStoragePath(config.root)) || !(await safeStoragePath(workspace))) throw new DispatchDeferredError('Unsafe linked workspace path');
  const root = await fs.realpath(config.root), target = await fs.realpath(workspace), source = await fs.realpath(checkout.source);
  if (source === target || source.startsWith(`${root}${path.sep}`) || root.startsWith(`${source}${path.sep}`)) throw new Error('Source checkout must be outside the managed workspace root');
  const gitEntry = await fs.lstat(path.join(workspace, '.git')).catch(() => null);
  if (gitEntry?.isFile()) {
    if (!(await ownsLinkedWorktree(config.root, workspace))) throw new DispatchDeferredError('Preserving an unowned linked worktree');
    const record = JSON.parse(await fs.readFile(path.join(root, '.symphony', 'repository.json'), 'utf8'));
    if (record.source !== source) throw new DispatchDeferredError('Shared repository belongs to a different source checkout');
    if (!preserveWork && !(await disposableCheckout(workspace, { linkedRoot: config.root }))) throw new DispatchDeferredError('Linked workspace contains protected work');
    return; // before_run fetches the task base; never reset a resumed workspace here.
  }
  if (gitEntry) {
    if (gitEntry.isDirectory() && !gitEntry.isSymbolicLink()) {
      if (await git(workspace, ['remote', 'get-url', 'origin']) !== await git(source, ['remote', 'get-url', 'origin'])) throw new DispatchDeferredError('Preserving a legacy checkout from a different repository');
      if (await git(workspace, ['rev-parse', '--show-toplevel']) !== target) throw new DispatchDeferredError('Preserving an invalid legacy checkout');
      // Dirty/unpublished clones stay intact for recovery. A clean clone can be
      // replaced while moving its ignored dependencies/artifacts, never copying them.
      if (preserveWork) return;
      if (!(await disposableCheckout(workspace))) throw new DispatchDeferredError('Legacy workspace contains protected work');
      const ignored = (await exec('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: workspace })).stdout.split('\0').filter(Boolean);
      const backup = `${workspace}.legacy-${randomUUID()}`;
      await fs.rename(workspace, backup);
      await fs.mkdir(workspace);
      const moved: string[] = [];
      try {
        await prepare(config, workspace, signal);
        for (const name of ignored) {
          const from = path.join(backup, name), to = path.join(workspace, name);
          if (await fs.lstat(to).catch(() => null)) throw new Error('New checkout conflicts with preserved cache');
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.rename(from, to); moved.push(name);
        }
        await fs.rm(backup, { recursive: true, force: true });
      } catch (error) {
        // Roll back known owned work only; leave any uncertain checkout/backup intact.
        for (const name of moved.reverse()) {
          await fs.mkdir(path.dirname(path.join(backup, name)), { recursive: true });
          await fs.rename(path.join(workspace, name), path.join(backup, name));
        }
        if (await ownsLinkedWorktree(config.root, workspace)) {
          await removeLinkedWorktree(config.root, workspace);
          await fs.rename(backup, workspace);
        }
        throw error;
      }
      return;
    }
    throw new DispatchDeferredError('Preserving unknown Git metadata');
  }
  const entries = await fs.readdir(workspace);
  if (entries.some(name => name !== '.symphony')) throw new DispatchDeferredError('Preserving files in an uninitialized workspace');
  const metadata = path.join(root, '.symphony');
  await fs.mkdir(metadata, { recursive: true });
  if (!(await safeStoragePath(metadata))) throw new Error('Unsafe repository metadata path');
  const mirror = mirrorFor(root), manifest = path.join(metadata, 'repository.json');
  const existing = await fs.lstat(mirror).catch(() => null);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || !(await safeStoragePath(mirror))) throw new Error('Unsafe shared repository');
    const record = JSON.parse(await fs.readFile(manifest, 'utf8'));
    if (record.source !== source) throw new Error('Shared repository belongs to a different source checkout');
  } else {
    if (await git(source, ['rev-parse', '--show-toplevel']) !== source) throw new Error('Invalid source checkout');
    const remote = await git(source, ['remote', 'get-url', 'origin']);
    const temporary = `${mirror}.creating`;
    const ownerFile = `${temporary}.json`;
    if (await fs.lstat(temporary).catch(() => null)) {
      const owner = await fs.readFile(ownerFile, 'utf8').then(JSON.parse, () => null);
      if (owner?.source !== source || !(await safeStoragePath(temporary))) throw new DispatchDeferredError('Unowned interrupted repository initialization');
      await fs.rm(temporary, { recursive: true, force: true });
    }
    await fs.writeFile(ownerFile, JSON.stringify({ source }), { mode: 0o600 });
    await git(metadata, ['clone', '--bare', '--local', '--dissociate', source, temporary], signal);
    await git(temporary, ['remote', 'set-url', 'origin', remote], signal);
    await git(temporary, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], signal);
    await git(temporary, ['fetch', '--no-tags', 'origin', `+refs/heads/${checkout.base_branch}:refs/remotes/origin/${checkout.base_branch}`], signal);
    await fs.writeFile(manifest, JSON.stringify({ version: 1, source }), { mode: 0o600 });
    await fs.rename(temporary, mirror);
    await fs.rm(ownerFile, { force: true });
  }
  const exclude = path.join(mirror, 'info', 'exclude');
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  const ignored = await fs.readFile(exclude, 'utf8').catch(() => '');
  if (!ignored.split('\n').includes('.symphony/')) await fs.appendFile(exclude, '\n.symphony/\n');
  // Prompts/artifacts may have been allocated before source checkout creation.
  const artifacts = path.join(workspace, '.symphony');
  const saved = `${workspace}.symphony-artifacts`;
  const hasArtifacts = await fs.lstat(artifacts).catch(() => null);
  if (hasArtifacts) await fs.rename(artifacts, saved);
  try {
    await git(mirror, ['worktree', 'add', '--detach', workspace, `refs/remotes/origin/${checkout.base_branch}`], signal);
    const gitDir = await git(workspace, ['rev-parse', '--absolute-git-dir']);
    await fs.writeFile(path.join(gitDir, markerName), JSON.stringify({ version: 1, root, workspace: target }), { mode: 0o600 });
  } finally {
    if (hasArtifacts) { await fs.mkdir(workspace, { recursive: true }); await fs.rename(saved, artifacts); }
  }
}

/** Managed worktree removal must unregister it, never recursively remove its .git file. */
export async function removeLinkedWorktree(root: string, workspace: string): Promise<void> {
  if (!(await ownsLinkedWorktree(root, workspace)) || !(await disposableCheckout(workspace, { linkedRoot: root }))) throw new DispatchDeferredError('Linked workspace contains protected work');
  // Ignored build artifacts are intentionally evicted only after the safety check.
  await git(mirrorFor(root), ['worktree', 'remove', '--force', workspace]);
}
