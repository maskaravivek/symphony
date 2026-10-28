import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { log } from '../utils/log.js';
import type { ServerConfig } from './types.js';

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', args, {
  cwd, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=10' },
})).stdout.trim();

export interface RepositorySyncResult {
  root: string;
  status: 'updated' | 'unchanged' | 'skipped' | 'failed';
  reason?: string;
}

async function skipReason(root: string): Promise<string | null> {
  if ((await git(root, 'symbolic-ref', '--short', '-q', 'HEAD').catch(() => '')) !== 'main') return 'not-on-main';
  const gitDir = path.resolve(root, await git(root, 'rev-parse', '--git-dir'));
  const commonDir = path.resolve(root, await git(root, 'rev-parse', '--git-common-dir'));
  if (gitDir !== commonDir) return 'linked-worktree';
  for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (await fs.stat(path.join(gitDir, marker)).then(() => true, () => false)) return 'git-operation-in-progress';
  }
  if (await git(root, 'status', '--porcelain', '--untracked-files=normal')) return 'local-changes';
  return null;
}

export async function syncPrimaryRepository(root: string): Promise<RepositorySyncResult> {
  try {
    const before = await skipReason(root);
    if (before) return { root, status: 'skipped', reason: before };
    await git(root, 'fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main');
    const after = await skipReason(root);
    if (after) return { root, status: 'skipped', reason: after };
    const head = await git(root, 'rev-parse', 'HEAD');
    const remote = await git(root, 'rev-parse', 'refs/remotes/origin/main');
    if (head === remote) return { root, status: 'unchanged' };
    try {
      await git(root, 'merge-base', '--is-ancestor', head, remote);
    } catch {
      return { root, status: 'skipped', reason: 'local-commits-or-divergence' };
    }
    await git(root, 'merge', '--ff-only', '--no-edit', '--no-autostash', '--no-overwrite-ignore', 'refs/remotes/origin/main');
    return { root, status: 'updated' };
  } catch {
    // Git errors can contain credential-bearing remote URLs. Keep logs generic.
    return { root, status: 'failed', reason: 'git-sync-failed' };
  }
}

/** Shared cadence for all configured primary checkouts, retained across restarts. */
export class RepositorySync {
  private running = false;
  private statePath: string;

  constructor(configPath: string, private now: () => number = Date.now) {
    this.statePath = path.join(path.dirname(path.resolve(configPath)), '.symphony', 'repository-sync.json');
  }

  async run(config: ServerConfig, busyRepoIds: Set<string>): Promise<RepositorySyncResult[]> {
    if (!config.repository_sync.enabled || this.running) return [];
    this.running = true;
    try {
      const lastAttempt = await fs.readFile(this.statePath, 'utf8').then(text => {
        const state = JSON.parse(text) as { last_attempt_ms?: number };
        if (!Number.isFinite(state.last_attempt_ms)) throw new Error('Invalid repository sync state');
        return state.last_attempt_ms!;
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const now = this.now();
      if (lastAttempt !== null && now - lastAttempt < config.repository_sync.interval_ms) return [];
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ last_attempt_ms: now }), { mode: 0o600 });
      await fs.rename(temporary, this.statePath);

      const selfRoot = await git(path.dirname(fileURLToPath(import.meta.url)), 'rev-parse', '--show-toplevel').catch(() => null);
      const roots = new Map<string, boolean>();
      const results: RepositorySyncResult[] = [];
      for (const repo of config.repos.filter(repo => repo.enabled)) {
        try {
          const root = await git(path.dirname(repo.workflow), 'rev-parse', '--show-toplevel');
          roots.set(root, (roots.get(root) ?? false) || busyRepoIds.has(repo.id));
        } catch {
          results.push({ root: path.dirname(repo.workflow), status: 'failed', reason: 'checkout-unavailable' });
        }
      }
      for (const [root, busy] of roots) {
        results.push(root === selfRoot ? { root, status: 'skipped', reason: 'symphony-checkout' }
          : busy ? { root, status: 'skipped', reason: 'active-agents' }
          : await syncPrimaryRepository(root));
      }
      for (const result of results) log(result.status === 'failed' ? 'warn' : 'info', 'repository_sync', { event: 'repository_sync', ...result });
      return results;
    } catch {
      log('warn', 'repository_sync_failed', { event: 'repository_sync_failed', reason: 'sync-state-unavailable' });
      return [];
    } finally {
      this.running = false;
    }
  }
}
