import { unstagedCacheChanges } from '../storage/generatedArtifacts.js';
import { hasLivePreparation } from './preparation.js';
import { ensureLinkedWorktree, ownsLinkedWorktree, releaseIdleTaskBranch, removeLinkedWorktree } from './linkedWorktrees.js';
import { disposableCheckout } from '../storage/checkoutSafety.js';
import { safeStoragePath } from '../storage/paths.js';
import { DispatchDeferredError, storagePolicy } from '../storage/policy.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Issue } from '../domain/issue.js';
import { readRunState } from '../status/runState.js';
import type { WorkspaceConfig, WorkspaceStrategy } from '../workflow/types.js';
import { assertPathWithinRoot } from '../utils/fs.js';

const execFileAsync = promisify(execFile);

export interface WorkspaceInfo {
  workspace_path: string;
  is_new: boolean;
  strategy: WorkspaceStrategy;
}

function sanitizeWorkspaceKey(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9._-]+/g, '_');
  return normalized.replace(/^_+|_+$/g, '');
}

function deriveWorkspaceKey(issue: Issue): string {
  // Prefer the spec's GitHub shape: owner/repo#123 -> owner_repo_123
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(issue.identifier);
  if (match) return sanitizeWorkspaceKey(`${match[1]}_${match[2]}_${match[3]}`);
  return sanitizeWorkspaceKey(issue.identifier);
}

export function workspacePathForIssue(workspaceRoot: string, issue: Issue): string {
  const workspaceKey = deriveWorkspaceKey(issue);
  const workspacePath = path.join(workspaceRoot, workspaceKey);
  assertPathWithinRoot(workspaceRoot, workspacePath);
  return workspacePath;
}

export function workspacePathForEpic(workspaceRoot: string, rootIssueIdentifier: string): string {
  const workspaceKey = sanitizeWorkspaceKey(`epic_${rootIssueIdentifier}`);
  const workspacePath = path.join(workspaceRoot, workspaceKey);
  assertPathWithinRoot(workspaceRoot, workspacePath);
  return workspacePath;
}

export function workspacePathForReadonlyIssue(workspaceRoot: string, issue: Issue): string {
  const workspaceKey = sanitizeWorkspaceKey(`readonly_${deriveWorkspaceKey(issue)}`);
  const workspacePath = path.join(workspaceRoot, workspaceKey);
  assertPathWithinRoot(workspaceRoot, workspacePath);
  return workspacePath;
}

export function workspacePathForPoolSlot(workspaceRoot: string, slot: number): string {
  const workspacePath = path.join(workspaceRoot, `_pool_${slot}`);
  assertPathWithinRoot(workspaceRoot, workspacePath);
  return workspacePath;
}

export class WorkspaceManager {
  private config: WorkspaceConfig;
  private poolSize: number;
  private allocations = new Map<string, string>();

  constructor(config: WorkspaceConfig, poolSize = 1) {
    this.config = config;
    this.poolSize = Math.max(1, Math.floor(poolSize));
  }

  async ensureWorkspace(
    issue: Issue,
    options: { strategy?: WorkspaceStrategy; epicRootIssueIdentifier?: string | null; preferredBranch?: string; originatingIssueNumber?: number | null } = {},
  ): Promise<WorkspaceInfo> {
    await fs.mkdir(this.config.root, { recursive: true });
    if (!(await safeStoragePath(this.config.root))) throw new DispatchDeferredError('Workspace root is redirected through a symlink');
    const strategy = options.strategy ?? 'durable_issue_workspace';
    const workspacePath =
      strategy === 'pooled_isolated'
        ? (options.preferredBranch ? await this.preferredReviewWorkspace(issue, options.preferredBranch, options.originatingIssueNumber) : null) ?? await this.acquirePoolWorkspace(issue)
        : strategy === 'none_or_readonly'
          ? workspacePathForReadonlyIssue(this.config.root, issue)
          : strategy === 'durable_epic_workspace'
            ? workspacePathForEpic(this.config.root, options.epicRootIssueIdentifier ?? issue.identifier)
            : workspacePathForIssue(this.config.root, issue);

    let isNew = false;
    try {
      await fs.access(workspacePath);
      if (!(await safeStoragePath(workspacePath))) throw new DispatchDeferredError('Workspace path is redirected through a symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      isNew = true;
      await fs.mkdir(workspacePath, { recursive: true });
    }
    if (await hasLivePreparation(workspacePath)) throw new DispatchDeferredError('Workspace is being prepared by a live coordinator');
    const previous = await readRunState(workspacePath);
    if (strategy === 'pooled_isolated' && previous && ['completed', 'failed', 'cancelled'].includes(previous.status)
      && await ownsLinkedWorktree(this.config.root, workspacePath) && await disposableCheckout(workspacePath, {linkedRoot:this.config.root})) {
      await this.cleanWorkspace(workspacePath, {retainCheckout:true});
    }
    this.allocations.set(issue.id, workspacePath);
    return { workspace_path: workspacePath, is_new: isNew, strategy };
  }

  lastWorkspaceForIssue(issueId: string): string | null {
    return this.allocations.get(issueId) ?? null;
  }

  private async preferredReviewWorkspace(issue: Issue, branch: string, originatingIssueNumber?: number | null): Promise<string | null> {
    const candidates: Array<{workspace:string; priority:number}> = [];
    for (const entry of await fs.readdir(this.config.root, {withFileTypes:true})) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ['_archives', '_loops'].includes(entry.name)) continue;
      const workspace = path.join(this.config.root, entry.name);
      if (!(await ownsLinkedWorktree(this.config.root, workspace))) continue;
      const state = await readRunState(workspace);
      const sameReview = state?.issue_id === issue.id;
      const currentBranch = (await execFileAsync('git', ['branch', '--show-current'], {cwd:workspace})).stdout.trim();
      const original = originatingIssueNumber != null && state?.issue_number === originatingIssueNumber;
      const matches = sameReview || original || currentBranch === branch;
      if (!matches) continue;
      if (await hasLivePreparation(workspace) || (state && ['preparing','agent-running','finalizing'].includes(state.status))) {
        throw new DispatchDeferredError('PR worktree is active or reserved');
      }
      const resume = Boolean(sameReview && state && ['paused','retry-wait'].includes(state.status));
      if (!resume && state && ['paused','retry-wait'].includes(state.status)) {
        throw new DispatchDeferredError('Original PR worktree is reserved for unfinished work');
      }
      if (!resume && !(await disposableCheckout(workspace, {linkedRoot:this.config.root}))) continue;
      candidates.push({workspace, priority:resume ? 0 : sameReview ? 1 : original ? 2 : 3});
    }
    candidates.sort((a,b) => a.priority-b.priority);
    return candidates[0]?.workspace ?? null;
  }

  private async acquirePoolWorkspace(issue: Issue): Promise<string> {
    const entries = await fs.readdir(this.config.root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const existingSlots = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => /^_pool_(\d+)$/.exec(entry.name))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => Number(match[1]))
      .filter((slot) => Number.isInteger(slot) && slot > 0);
    const highestExistingSlot = existingSlots.length > 0 ? Math.max(...existingSlots) : 0;
    const highestReusableSlot = Math.max(this.poolSize, highestExistingSlot);
    const reservedStatuses = new Set(['agent-running', 'finalizing', 'retry-wait', 'paused']);

    for (let slot = 1; slot <= highestExistingSlot; slot += 1) {
      const workspacePath = workspacePathForPoolSlot(this.config.root, slot);
      const state = await readRunState(workspacePath);
      if (state?.issue_id === issue.id && (state.status === 'paused' || state.status === 'retry-wait')) return workspacePath;
    }

    const limit = Math.max(this.poolSize, storagePolicy(this.config.storage_maintenance).max_pool_slots);
    for (let slot = 1; slot <= Math.min(highestReusableSlot, limit); slot += 1) {
      const workspacePath = workspacePathForPoolSlot(this.config.root, slot);
      if (await hasLivePreparation(workspacePath)) continue;
      const state = await readRunState(workspacePath);
      if (state && reservedStatuses.has(state.status)) continue;
      const entries = await fs.readdir(workspacePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      // Reusing a slot runs destructive checkout hooks: apply the same local-work protections as deletion.
      const owned = await ownsLinkedWorktree(this.config.root, workspacePath);
      const reusable = await disposableCheckout(workspacePath, { linkedRoot: this.config.root });
      if (entries.length === 0 || (reusable && (owned || Boolean(state)))) return workspacePath;
    }

    if (highestReusableSlot >= limit) throw new DispatchDeferredError(`Workspace pool limit (${limit}) reached; resume or finish reserved jobs before dispatching more work`);
    return workspacePathForPoolSlot(this.config.root, highestReusableSlot + 1);
  }

  async prepareCheckout(workspacePath: string, signal?: AbortSignal, branch?: string, preserveWork = false): Promise<void> {
    assertPathWithinRoot(this.config.root, workspacePath);
    const state = await readRunState(workspacePath);
    const resume = preserveWork || state?.status === 'paused' || state?.status === 'retry-wait';
    await ensureLinkedWorktree(this.config, workspacePath, signal, resume);
    if (branch) await releaseIdleTaskBranch(this.config, workspacePath, branch, signal);
  }

  async hasGitRepo(workspacePath: string): Promise<boolean> {
    assertPathWithinRoot(this.config.root, workspacePath);
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: workspacePath,
        timeout: 10_000,
      });
      const [gitTopLevel, canonicalWorkspacePath] = await Promise.all([
        fs.realpath(stdout.trim()),
        fs.realpath(workspacePath),
      ]);
      return gitTopLevel === canonicalWorkspacePath;
    } catch {
      return false;
    }
  }

  async isWorkspaceEmpty(workspacePath: string): Promise<boolean> {
    assertPathWithinRoot(this.config.root, workspacePath);
    const entries = await fs.readdir(workspacePath);
    return entries.length === 0;
  }

  async clearWorkspaceContents(workspacePath: string): Promise<void> {
    assertPathWithinRoot(this.config.root, workspacePath);
    const entries = await fs.readdir(workspacePath);
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(workspacePath, entry);
        await fs.rm(entryPath, { recursive: true, force: true });
      }),
    );
  }

  async writePrompt(workspacePath: string, prompt: string): Promise<string> {
    assertPathWithinRoot(this.config.root, workspacePath);
    await fs.mkdir(path.join(workspacePath, '.symphony'), { recursive: true });
    const promptPath = path.join(workspacePath, '.symphony', 'prompt.md');
    await fs.writeFile(promptPath, prompt, 'utf8');
    return promptPath;
  }

  async cleanWorkspace(workspacePath: string, options: { evict?: boolean; retainCheckout?: boolean } = {}): Promise<void> {
    if (!this.config.clean_on_terminal && !options.retainCheckout) return;
    assertPathWithinRoot(this.config.root, workspacePath);
    if (!(await safeStoragePath(workspacePath))) throw new Error('Unsafe workspace cleanup path');
    const linked = await ownsLinkedWorktree(this.config.root, workspacePath);
    const pooled = options.retainCheckout || /^_pool_[1-9][0-9]*$/.test(path.basename(workspacePath))
      || (linked && (await readRunState(workspacePath))?.workspace_strategy === 'pooled_isolated');
    if (linked && !(await disposableCheckout(workspacePath, { linkedRoot: this.config.root }))) throw new DispatchDeferredError('Preserving protected linked workspace');
    const stamp = linked && pooled ? await fs.readFile(path.join(workspacePath, '.symphony', 'dependencies.json')).catch(() => null) : null;
    const trackedArtifacts = linked
      ? (await execFileAsync('git', ['ls-files', '-z', '--', '.symphony'], { cwd: workspacePath })).stdout
      : '';
    const cacheChanges = linked ? unstagedCacheChanges((await execFileAsync('git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspacePath })).stdout) : [];
    const archive = await this.archiveSymphonyArtifacts(workspacePath);
    if (cacheChanges.length) await execFileAsync('git', ['restore', '--worktree', '--', ...cacheChanges], { cwd: workspacePath });
    if (trackedArtifacts) await execFileAsync('git', ['restore', '--worktree', '--', '.symphony'], { cwd: workspacePath });
    if (linked && pooled && !options.evict) {
      await fs.mkdir(path.join(workspacePath, '.symphony'), { recursive: true });
      if (stamp) await fs.writeFile(path.join(workspacePath, '.symphony', 'dependencies.json'), stamp);
      const now = new Date(); await fs.utimes(workspacePath, now, now);
      return; // Warm slots retain source, dependency installations and build caches.
    }
    try {
      if (linked) await removeLinkedWorktree(this.config.root, workspacePath);
      else await fs.rm(workspacePath, { recursive: true, force: true });
    } catch (error) {
      if (archive) {
        await fs.mkdir(workspacePath, { recursive: true });
        await fs.rename(archive, path.join(workspacePath, '.symphony'));
      }
      throw error;
    }
  }

  private async archiveSymphonyArtifacts(workspacePath: string): Promise<string | null> {
    const artifactsPath = path.join(workspacePath, '.symphony');
    try {
      const stat = await fs.lstat(artifactsPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid workspace artifact directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const workspaceName = path.basename(workspacePath);
    const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(this.config.root, '_archives', `${workspaceName}-${safeTimestamp}`);
    assertPathWithinRoot(this.config.root, archivePath);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    if (!(await safeStoragePath(path.dirname(archivePath)))) throw new Error('Unsafe workspace archive path');
    await fs.rename(artifactsPath, archivePath);
    const now = new Date();
    await fs.utimes(archivePath, now, now);
    return archivePath;
  }
}
