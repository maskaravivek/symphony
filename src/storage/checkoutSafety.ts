import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeStoragePath } from './paths.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, timeout: 15_000 })).stdout.trim();
const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

/** All local branches must be represented in remote-tracking refs. Never fetch or reset here. */
export async function disposableCheckout(workspace: string): Promise<boolean> {
  try {
    if (!(await safeStoragePath(workspace))) return false;
    const gitDir = await fs.lstat(path.join(workspace, '.git'));
    if (!gitDir.isDirectory() || gitDir.isSymbolicLink()) return false; // preserve linked worktrees
    if (await git(workspace, 'status', '--porcelain', '--untracked-files=all')) return false;
    if (await git(workspace, 'stash', 'list')) return false;
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      if (await exists(path.join(workspace, '.git', marker))) return false;
    }
    if (await git(workspace, 'rev-list', 'HEAD', '--branches', '--tags', '--not', '--remotes')) return false;
    // Only known generated ignored directories may disappear with the checkout.
    const ignored = await git(workspace, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory');
    return ignored.split('\n').filter(Boolean).every(name =>
      ['.symphony/', 'node_modules/', '.next/', '.turbo/', 'dist/', 'build/', 'coverage/'].some(prefix => name.startsWith(prefix)));
  } catch {
    return false;
  }
}

