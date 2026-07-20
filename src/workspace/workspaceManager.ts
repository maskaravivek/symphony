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
    options: { strategy?: WorkspaceStrategy; epicRootIssueIdentifier?: string | null } = {},
  ): Promise<WorkspaceInfo> {
    const strategy = options.strategy ?? 'durable_issue_workspace';
    const workspacePath =
      strategy === 'pooled_isolated'
        ? await this.acquirePoolWorkspace(issue)
        : strategy === 'none_or_readonly'
          ? workspacePathForReadonlyIssue(this.config.root, issue)
          : strategy === 'durable_epic_workspace'
            ? workspacePathForEpic(this.config.root, options.epicRootIssueIdentifier ?? issue.identifier)
            : workspacePathForIssue(this.config.root, issue);

    let isNew = false;
    try {
      await fs.access(workspacePath);
    } catch {
      isNew = true;
      await fs.mkdir(workspacePath, { recursive: true });
    }
    this.allocations.set(issue.id, workspacePath);
    return { workspace_path: workspacePath, is_new: isNew, strategy };
  }

  lastWorkspaceForIssue(issueId: string): string | null {
    return this.allocations.get(issueId) ?? null;
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

    for (let slot = 1; slot <= highestReusableSlot; slot += 1) {
      const workspacePath = workspacePathForPoolSlot(this.config.root, slot);
      const state = await readRunState(workspacePath);
      if (!state || !reservedStatuses.has(state.status)) return workspacePath;
    }

    return workspacePathForPoolSlot(this.config.root, highestReusableSlot + 1);
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

  async cleanWorkspace(workspacePath: string): Promise<void> {
    if (!this.config.clean_on_terminal) return;
    assertPathWithinRoot(this.config.root, workspacePath);
    await this.archiveSymphonyArtifacts(workspacePath);
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  private async archiveSymphonyArtifacts(workspacePath: string): Promise<void> {
    const artifactsPath = path.join(workspacePath, '.symphony');
    try {
      await fs.access(artifactsPath);
    } catch {
      return;
    }

    const workspaceName = path.basename(workspacePath);
    const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(this.config.root, '_archives', `${workspaceName}-${safeTimestamp}`);
    assertPathWithinRoot(this.config.root, archivePath);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.cp(artifactsPath, archivePath, { recursive: true, force: true });
  }
}
