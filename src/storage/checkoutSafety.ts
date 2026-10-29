import { generatedOutput } from './generatedArtifacts.js';
import { readRunState } from '../status/runState.js';
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
    const dirty = (await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspace, timeout: 15_000 })).stdout;
    if (dirty && (!linked || dirty !== ' M .symphony/verification.json\0' || !(await archivedTerminalEvidence(workspace)))) return false;
    if (await git(workspace, 'stash', 'list')) return false;
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      if (await exists(path.resolve(workspace, await git(workspace, 'rev-parse', '--git-path', marker)))) return false;
    }
    if (await git(workspace, 'rev-list', 'HEAD', ...(linked ? [] : ['--branches', '--tags']), '--not', '--remotes')) return false;
    // Only known generated ignored directories may disappear with the checkout.
    const ignored = await git(workspace, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory');
    for (const name of ignored.split('\n').filter(Boolean)) {
      // Tracked configuration within .symphony makes Git enumerate ignored artifacts individually.
      if (name.startsWith('.symphony/') || generatedOutput(name)) continue;
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



/** Only the exact runtime evidence already captured for this terminal session may be released. */
async function archivedTerminalEvidence(workspace: string): Promise<boolean> {
  const state = await readRunState(workspace);
  if (!state || !['completed', 'failed', 'cancelled'].includes(state.status) || !state.session_artifact_dir) return false;
  const artifacts = path.resolve(state.session_artifact_dir);
  if (!artifacts.startsWith(path.join(path.resolve(workspace), '.symphony', 'runs') + path.sep)) return false;
  const source = path.join(workspace, '.symphony', 'verification.json');
  const snapshot = path.join(artifacts, 'verification.json');
  if (!(await safeStoragePath(source)) || !(await safeStoragePath(snapshot))) return false;
  const [current, archived] = await Promise.all([fs.readFile(source), fs.readFile(snapshot)]);
  const value = JSON.parse(current.toString());
  return current.equals(archived) && value.version === 1 && Array.isArray(value.evidence)
    && value.head_sha === await git(workspace, 'rev-parse', 'HEAD');
}
