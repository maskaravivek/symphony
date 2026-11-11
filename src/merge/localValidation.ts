import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { PullRequestRef } from '../github/githubClient.js';
import { runHookScript } from '../workspace/hooks.js';
import type { VerificationEvidence } from './mergePolicy.js';

const execFileAsync = promisify(execFile);

export class LocalValidationRefsChangedError extends Error {}

/** Use an isolated checkout so a manual retry can also validate an archived run. */
export async function withPullRequestCheckout<T>(
  source: string, pr: PullRequestRef, validate: (workspacePath: string) => Promise<T>,
): Promise<T> {
  if (!pr.head_sha || !pr.head_ref) throw new Error('Local validation requires a PR head commit and branch');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-validation-'));
  const checkout = path.join(root, 'checkout');
  const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', args, {
    cwd, timeout: 300_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })).stdout.trim();
  try {
    const origin = await git(source, 'remote', 'get-url', 'origin');
    await git(root, 'clone', '--shared', '--no-checkout', '--', source, checkout);
    await git(checkout, 'remote', 'set-url', 'origin', origin);
    await fs.appendFile(path.join(checkout, '.git', 'info', 'exclude'), '\n.symphony/\n');
    await git(checkout, 'fetch', 'origin', `refs/heads/${pr.head_ref}`);
    if (await git(checkout, 'rev-parse', 'FETCH_HEAD') !== pr.head_sha) {
      throw new Error('The PR head changed before validation. Retry against the updated PR.');
    }
    await git(checkout, 'checkout', '--detach', pr.head_sha);
    return await validate(checkout);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Merging the base into the PR branch hit conflicts; the workspace has been restored. */
export class PullRequestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullRequestConflictError';
  }
}

export interface BaseSyncResult {
  /** True when the base was merged into the branch and pushed; the PR's head commit changed. */
  updated: boolean;
  head_sha: string;
  base_sha: string;
}

/**
 * Brings the PR branch up to date with its base before validation. A resumed workspace is
 * often behind `main` (the branch was cut an attempt ago), and validation requires the base
 * commit to be an ancestor of the head. Rather than failing the attempt, merge the base in
 * and push; on conflicts, restore the workspace and throw PullRequestConflictError so the
 * caller can queue conflict resolution.
 */
export async function syncPullRequestWithBase(options: {
  workspacePath: string;
  pullRequest: PullRequestRef;
  signal?: AbortSignal;
}): Promise<BaseSyncResult> {
  const { workspacePath, pullRequest: pr, signal } = options;
  if (!pr.head_sha || !pr.head_ref || !pr.base_ref) throw new Error('Base sync requires the PR head commit, head branch and base branch');
  const git = async (...args: string[]) => (await execFileAsync('git', args, {
    cwd: workspacePath, timeout: 120_000, signal,
  })).stdout.trim();
  if (await git('rev-parse', 'HEAD') !== pr.head_sha) throw new Error('Base sync head does not match the PR');
  if (await git('status', '--porcelain')) throw new Error('Base sync requires a clean workspace');
  await git('fetch', 'origin', pr.base_ref);
  const baseSha = await git('rev-parse', 'FETCH_HEAD');
  const isAncestor = await git('merge-base', '--is-ancestor', baseSha, 'HEAD').then(() => true, () => false);
  if (isAncestor) return { updated: false, head_sha: pr.head_sha, base_sha: baseSha };
  try {
    await git('merge', '--no-edit', '-m', `Merge ${pr.base_ref} into ${pr.head_ref}`, baseSha);
  } catch (error) {
    const conflicted = await git('diff', '--name-only', '--diff-filter=U').catch(() => '');
    await git('merge', '--abort').catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new PullRequestConflictError(`Merging ${pr.base_ref} into ${pr.head_ref} conflicts${conflicted ? ` (${conflicted.split('\n').join(', ')})` : ''}: ${detail.split('\n')[0]}`);
  }
  await git('push', 'origin', `HEAD:${pr.head_ref}`);
  return { updated: true, head_sha: await git('rev-parse', 'HEAD'), base_sha: baseSha };
}

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
      throw new LocalValidationRefsChangedError('PR head or base changed; local validation must be rerun');
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
