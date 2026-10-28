import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { PullRequestRef } from '../github/githubClient.js';
import { runHookScript } from '../workspace/hooks.js';
import type { VerificationEvidence } from './mergePolicy.js';

const execFileAsync = promisify(execFile);

/** Run repository-owned checks and bind their success to the exact local/remote commits. */
export async function validateLocalPullRequest(options: {
  workspacePath: string;
  pullRequest: PullRequestRef;
  command: string;
  timeoutMs: number;
  logPath: string;
  signal?: AbortSignal;
}): Promise<VerificationEvidence> {
  const { workspacePath, pullRequest: pr, command, timeoutMs, logPath, signal } = options;
  if (!command.trim()) throw new Error('A local validation command is required');
  if (!pr.head_sha || !pr.base_sha) throw new Error('Local validation requires PR head and base commits');
  const git = async (...args: string[]) => (await execFileAsync('git', args, {
    cwd: workspacePath, timeout: 120_000, signal,
  })).stdout.trim();
  const requireUnchanged = async () => {
    if (await git('rev-parse', 'HEAD') !== pr.head_sha) throw new Error('Local validation head does not match the PR');
    if (await git('status', '--porcelain')) throw new Error('Local validation requires a clean workspace');
    const refs = await git('ls-remote', 'origin', `refs/heads/${pr.head_ref}`, `refs/heads/${pr.base_ref}`);
    const remote = new Map(refs.split('\n').map((line) => {
      const [sha, ref] = line.split(/\s+/);
      return [ref, sha];
    }));
    if (remote.get(`refs/heads/${pr.head_ref}`) !== pr.head_sha || remote.get(`refs/heads/${pr.base_ref}`) !== pr.base_sha) {
      throw new Error('PR head or base changed; local validation must be rerun');
    }
  };
  await requireUnchanged();
  await git('fetch', 'origin', pr.base_ref);
  await git('merge-base', '--is-ancestor', pr.base_sha, 'HEAD');
  await runHookScript(`set -euo pipefail\n${command}`, workspacePath, timeoutMs, {
    logPath, signal,
    env: { SYMPHONY_VALIDATION_BASE_REF: pr.base_ref, SYMPHONY_VALIDATION_HEAD_SHA: pr.head_sha, SYMPHONY_VALIDATION_BASE_SHA: pr.base_sha },
  });
  await requireUnchanged();
  return { kind: 'validation', summary: 'Repository local validation passed on the current PR head and base.', command, artifact: logPath };
}
