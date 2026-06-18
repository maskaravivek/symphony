import { execFile } from 'node:child_process';

export interface FreshRunGitRecoveryResult {
  recovered: boolean;
  unmerged_files: string[];
}

function runGit(workspacePath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: workspacePath }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function tryGit(workspacePath: string, args: string[]): Promise<void> {
  await runGit(workspacePath, args).catch(() => undefined);
}

export async function recoverFreshRunGitState(workspacePath: string): Promise<FreshRunGitRecoveryResult> {
  const unmerged = await runGit(workspacePath, ['diff', '--name-only', '--diff-filter=U']);
  const unmergedFiles = unmerged ? unmerged.split('\n').filter(Boolean) : [];
  if (unmergedFiles.length === 0) return { recovered: false, unmerged_files: [] };

  await tryGit(workspacePath, ['merge', '--abort']);
  await tryGit(workspacePath, ['rebase', '--abort']);
  await tryGit(workspacePath, ['cherry-pick', '--abort']);
  await tryGit(workspacePath, ['revert', '--abort']);
  await runGit(workspacePath, ['reset', '--hard']);

  return { recovered: true, unmerged_files: unmergedFiles };
}
