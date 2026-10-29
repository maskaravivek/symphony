import { generatedOutput } from './generatedArtifacts.js';
import { hasLivePreparation } from '../workspace/preparation.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ownsLinkedWorktree } from '../workspace/linkedWorktrees.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceConfig } from '../workflow/types.js';
import { readRunState } from '../status/runState.js';
import { pruneSessionArtifacts } from '../artifacts/sessionArtifacts.js';
import { WorkspaceManager } from '../workspace/workspaceManager.js';
import { log } from '../utils/log.js';
import { DAY, GIB, storagePolicy } from './policy.js';
import { safeStoragePath } from './paths.js';
import { disposableCheckout } from './checkoutSafety.js';

const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

/** Never follow symlinks while counting or selecting disposable artifacts. */
async function bytes(file: string): Promise<number> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of await fs.readdir(file)) total += await bytes(path.join(file, name));
  return total;
}

/** Deletes only entries in an explicitly owned artifact/cache directory. */
export async function pruneOwnedDirectory(root: string, options: {
  cutoff: number; maxBytes: number; maxCount?: number; accept?: (name: string) => boolean;
}): Promise<number> {
  if (!(await safeStoragePath(root))) return 0;
  const entries = [];
  for (const name of await fs.readdir(root)) {
    if (options.accept && !options.accept(name)) continue;
    const file = path.join(root, name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) continue;
    entries.push({ file, time: stat.mtimeMs, bytes: await bytes(file) });
  }
  entries.sort((a, b) => b.time - a.time);
  let keptBytes = 0;
  let keptCount = 0;
  let removedBytes = 0;
  for (const entry of entries) {
    if (entry.time >= options.cutoff && keptCount < (options.maxCount ?? Infinity)
      && keptBytes + entry.bytes <= options.maxBytes) {
      keptBytes += entry.bytes;
      keptCount++;
    } else {
      await fs.rm(entry.file, { recursive: true, force: true });
      removedBytes += entry.bytes;
    }
  }
  return removedBytes;
}

export async function storageAvailable(root: string, minFreeGiB: number): Promise<boolean> {
  try {
    const stat = await fs.statfs(root);
    return stat.bavail * stat.bsize >= minFreeGiB * GIB;
  } catch {
    return false;
  }
}


/** Reclaim ignored generated output, keeping installed dependencies in warm slots. */
async function pruneWorkspaceCaches(workspace: string, cutoff: number, budget: number): Promise<number> {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: workspace, timeout: 15_000 });
  const candidates = [];
  for (const name of stdout.split('\0').filter(Boolean)) {
    if (!generatedOutput(name)) continue;
    const file = path.resolve(workspace, name);
    if (!file.startsWith(`${path.resolve(workspace)}${path.sep}`) || !(await safeStoragePath(file))) continue;
    const tracked = await promisify(execFile)('git', ['ls-files', '--', name], { cwd: workspace, timeout: 15_000 });
    if (tracked.stdout.trim()) continue;
    candidates.push({ file, time: (await fs.stat(file)).mtimeMs, size: await bytes(file) });
  }
  candidates.sort((a, b) => b.time - a.time);
  let kept = 0, removed = 0;
  for (const item of candidates) {
    if (item.time >= cutoff && kept + item.size <= budget) kept += item.size;
    else { await fs.rm(item.file, { recursive: true, force: true }); removed += item.size; }
  }
  return removed;
}

/** Called only under the workflow lock. Busy repositories are retried on the next tick. */
export async function maintainStorage(config: WorkspaceConfig, busy: boolean, now = Date.now()): Promise<void> {
  const policy = storagePolicy(config.storage_maintenance);
  if (!policy.enabled || busy || !(await safeStoragePath(config.root))) return;
  // A workspace root must be a container, never a primary checkout.
  if (await exists(path.join(config.root, '.git'))) return;
  const statePath = path.join(config.root, '.symphony', 'storage-maintenance.json');
  try {
    const previous = await fs.readFile(statePath, 'utf8').then(raw => JSON.parse(raw) as { completed_at_ms: number })
      .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous && !Number.isFinite(previous.completed_at_ms)) throw new Error('Invalid maintenance state');
    if (previous && now - previous.completed_at_ms < policy.interval_ms) return;
    // A restarted daemon may not have recovered live workers into its maps yet.
    for (const entry of await fs.readdir(config.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (await hasLivePreparation(path.join(config.root, entry.name))) return;
      const state = await readRunState(path.join(config.root, entry.name));
      if (state?.worker_pid) {
        try { process.kill(state.worker_pid, 0); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
      }
    }
    const cutoff = now - policy.retention_days * DAY;
    let reclaimed = 0;
    let workspacesRemoved = 0;
    const manager = new WorkspaceManager(config);
    let warmSlots = 0;
    const entries = await fs.readdir(config.root, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ['_archives', '_loops'].includes(entry.name)) continue;
      const workspace = path.join(config.root, entry.name);
      if (!(await safeStoragePath(workspace))) continue;
      const state = await readRunState(workspace);
      if (/^_pool_[1-9][0-9]*$/.test(entry.name) && await ownsLinkedWorktree(config.root, workspace)) {
        if (state && !['completed', 'failed', 'cancelled'].includes(state.status)) continue;
        if (!(await disposableCheckout(workspace, { linkedRoot: config.root }))) continue;
        if (warmSlots++ < policy.warm_pool_slots) {
          reclaimed += await pruneWorkspaceCaches(workspace, cutoff, policy.max_cache_gib * GIB);
        } else if ((await fs.stat(workspace)).mtimeMs < now - policy.idle_days * DAY) {
          await manager.cleanWorkspace(workspace, { evict: true }); workspacesRemoved++;
        }
        continue;
      }
      // Unknown, interrupted, paused, finalizing and retry workspaces need human/runtime recovery.
      if (!state || !['completed', 'failed', 'cancelled'].includes(state.status)) continue;
      if (state.worker_pid) {
        try { process.kill(state.worker_pid, 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      }
      if (path.resolve(state.workspace_path) !== path.resolve(workspace)) continue;
      const updated = Date.parse(state.updated_at);
      if (!Number.isFinite(updated)) continue;
      if (config.clean_on_terminal && updated < now - policy.idle_days * DAY && await disposableCheckout(workspace)) {
        await manager.cleanWorkspace(workspace);
        workspacesRemoved++;
      } else {
        // Preserve the latest session even when its artifacts exceed the budget.
        await pruneSessionArtifacts(path.join(workspace, '.symphony', 'runs'), {
          activeDir: state.session_artifact_dir ?? null, maxAgeDays: policy.retention_days, maxSessions: 50, maxBytes: policy.max_artifact_gib * GIB,
        });
      }
    }
    reclaimed += await pruneOwnedDirectory(path.join(config.root, '_archives'), {
      cutoff, maxBytes: policy.max_artifact_gib * GIB,
    });
    for (const hookRoot of [path.join(config.root, '.symphony', 'hooks'), path.join(config.root, '_loops', '.symphony', 'hooks')]) {
      if (!(await safeStoragePath(hookRoot))) continue;
      for (const entry of await fs.readdir(hookRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        reclaimed += await pruneOwnedDirectory(path.join(hookRoot, entry.name), {
          cutoff, maxBytes: 100 * 1024 ** 2, accept: name => /^\d{4}-.*\.log$/.test(name),
        });
      }
    }
    const cacheLocks = policy.cache_root ? await fs.readdir(path.join(policy.cache_root, 'node_modules')).then(names => names.some(name => name.endsWith('.lock')), () => false) : false;
    if (policy.cache_root && !cacheLocks && await safeStoragePath(policy.cache_root)) {
      // Git mirrors may be referenced via alternates: never remove them.
      reclaimed += await pruneOwnedDirectory(path.join(policy.cache_root, 'node_modules'), {
        cutoff: now - 14 * DAY, maxBytes: policy.max_cache_gib * GIB, maxCount: 3,
        accept: name => /^[a-f0-9]{64}(\.tmp\.\d+)?$/.test(name),
      });
      reclaimed += await pruneOwnedDirectory(path.join(policy.cache_root, 'yarn', 'v6'), {
        cutoff, maxBytes: policy.max_cache_gib * GIB, accept: name => name.startsWith('npm-'),
      });
    }
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ completed_at_ms: now, artifact_bytes_removed: reclaimed, workspaces_removed: workspacesRemoved }), { mode: 0o600 });
    await fs.rename(tmp, statePath);
    log('info', 'storage_maintenance_completed', { event: 'storage_maintenance_completed', workspace_root: config.root,
      artifact_bytes_removed: reclaimed, workspaces_removed: workspacesRemoved });
  } catch (error) {
    log('warn', 'storage_maintenance_failed', { event: 'storage_maintenance_failed', workspace_root: config.root,
      error: error instanceof Error ? error.message : String(error) });
  }
}
