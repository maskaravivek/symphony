import { ownsLinkedWorktree } from '../workspace/linkedWorktrees.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeStoragePath } from './paths.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, timeout: 15_000 })).stdout.trim();
const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

/** All local branches must be represented in remote-tracking refs. Never fetch or reset here. */
export async function disposableCheckout(workspace: string, options: { linkedRoot?: string } = {}): Promise<boolean> {
  try {
    if (!(await safeStoragePath(workspace))) return false;
    const gitDir = await fs.lstat(path.join(workspace, '.git'));
    const linked = Boolean(options.linkedRoot && await ownsLinkedWorktree(options.linkedRoot, workspace));
    if ((!gitDir.isDirectory() && !linked) || gitDir.isSymbolicLink()) return false;
    if (await git(workspace, 'status', '--porcelain', '--untracked-files=all')) return false;
    if (await git(workspace, 'stash', 'list')) return false;
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      if (await exists(path.resolve(workspace, await git(workspace, 'rev-parse', '--git-path', marker)))) return false;
    }
    if (await git(workspace, 'rev-list', 'HEAD', ...(linked ? [] : ['--branches', '--tags']), '--not', '--remotes')) return false;
    // Only known generated ignored directories may disappear with the checkout.
    const ignored = await git(workspace, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory');
    for (const name of ignored.split('\n').filter(Boolean)) {
      // Tracked configuration within .symphony makes Git enumerate ignored artifacts individually.
      if (name.startsWith('.symphony/')) continue;
      if (/(^|\/)(\.symphony|node_modules|\.next|\.turbo|\.gradle|\.kotlin|\.cxx|\.build|\.swiftpm|DerivedData|dist|build|coverage)\/$/.test(name)) continue;
      // Android setup may generate this file. Credentials/custom settings remain protected.
      if (/(^|\/)local.properties$/.test(name)) {
        const contents = await fs.readFile(path.join(workspace, name), 'utf8');
        if (contents.split('\n').every(line => !line.trim() || line.startsWith('#') || /^sdk\.dir=/.test(line))) continue;
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

