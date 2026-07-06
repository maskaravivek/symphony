import fs from 'node:fs/promises';
import path from 'node:path';

import type { Issue } from '../domain/issue.js';
import type { WorkspaceConfig } from '../workflow/types.js';
import { assertPathWithinRoot } from '../utils/fs.js';

export interface WorkspaceInfo {
  workspace_path: string;
  is_new: boolean;
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

export class WorkspaceManager {
  private config: WorkspaceConfig;

  constructor(config: WorkspaceConfig) {
    this.config = config;
  }

  async ensureWorkspace(issue: Issue): Promise<WorkspaceInfo> {
    const workspacePath = workspacePathForIssue(this.config.root, issue);

    let isNew = false;
    try {
      await fs.access(workspacePath);
    } catch {
      isNew = true;
      await fs.mkdir(workspacePath, { recursive: true });
    }
    return { workspace_path: workspacePath, is_new: isNew };
  }

  async hasGitRepo(workspacePath: string): Promise<boolean> {
    assertPathWithinRoot(this.config.root, workspacePath);
    try {
      await fs.access(path.join(workspacePath, '.git'));
      return true;
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
