import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recoverFreshRunGitState } from './gitRecovery.js';

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  return run('git', args, cwd);
}

test('recovers a fresh run workspace from an unresolved merge index', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-git-recovery-'));

  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'symphony@test.local']);
  await git(repo, ['config', 'user.name', 'Symphony Test']);
  await fs.writeFile(path.join(repo, 'conflict.txt'), 'base\n', 'utf8');
  await git(repo, ['add', 'conflict.txt']);
  await git(repo, ['commit', '-m', 'base']);

  await git(repo, ['checkout', '-b', 'feature']);
  await fs.writeFile(path.join(repo, 'conflict.txt'), 'feature\n', 'utf8');
  await git(repo, ['commit', '-am', 'feature']);

  await git(repo, ['checkout', 'main']);
  await fs.writeFile(path.join(repo, 'conflict.txt'), 'main\n', 'utf8');
  await git(repo, ['commit', '-am', 'main']);

  await git(repo, ['checkout', 'feature']);
  await assert.rejects(git(repo, ['merge', 'main']));
  assert.equal(await git(repo, ['diff', '--name-only', '--diff-filter=U']), 'conflict.txt');

  const recovery = await recoverFreshRunGitState(repo);

  assert.deepEqual(recovery, { recovered: true, unmerged_files: ['conflict.txt'] });
  assert.equal(await git(repo, ['diff', '--name-only', '--diff-filter=U']), '');
  assert.equal(await git(repo, ['status', '--short']), '');
  assert.equal(await git(repo, ['checkout', 'main']).then(() => 'ok'), 'ok');
});

test('leaves a clean workspace untouched', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-git-recovery-clean-'));

  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'symphony@test.local']);
  await git(repo, ['config', 'user.name', 'Symphony Test']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'clean\n', 'utf8');
  await git(repo, ['add', 'file.txt']);
  await git(repo, ['commit', '-m', 'clean']);

  const recovery = await recoverFreshRunGitState(repo);

  assert.deepEqual(recovery, { recovered: false, unmerged_files: [] });
  assert.equal(await git(repo, ['status', '--short']), '');
});
