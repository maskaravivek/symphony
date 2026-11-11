import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GithubIssueTrackerClient, type PullRequestRef } from '../github/githubClient.js';
import { loadWorkflowFromFile } from '../workflow/loadWorkflow.js';
import type { WorkflowConfig } from '../workflow/types.js';
import type { Issue } from '../domain/issue.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { readRunState, writeRunState } from '../status/runState.js';
import { PullRequestConflictError, syncPullRequestWithBase, validateLocalPullRequest } from './localValidation.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-local-validation-'));
  const remote = path.join(root, 'remote.git');
  const workspacePath = path.join(root, 'workspace');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', workspacePath], { stdio: 'ignore' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(workspacePath, 'app.txt'), 'base');
  await fs.writeFile(path.join(workspacePath, '.git/info/exclude'), '.symphony/\n');
  git('add', 'app.txt'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
  git('checkout', '-b', 'symphony-1');
  await fs.writeFile(path.join(workspacePath, 'app.txt'), 'change');
  git('commit', '-am', 'change'); git('push', 'origin', 'symphony-1');
  const pr: PullRequestRef = {
    number: 2, title: 'Change', body: 'Fixes #1', state: 'open', labels: [], is_draft: false, url: null,
    head_ref: 'symphony-1', head_sha: git('rev-parse', 'HEAD'), base_ref: 'main', base_sha: base, merge_state_status: 'clean',
  };
  return { root, remote, git, options: { workspacePath, pullRequest: pr, command: 'echo checked', timeoutMs: 5000, logPath: path.join(workspacePath, '.symphony/validation.log') } };
}

test('runs local checks without a reviewer and records the command and log', async () => {
  const { options } = await fixture();
  const evidence = await validateLocalPullRequest(options);
  assert.equal(evidence.kind, 'validation');
  assert.equal(evidence.command, 'echo checked');
  assert.match(await fs.readFile(options.logPath, 'utf8'), /checked/);
});

test('failed checks and dirty validation output cannot become merge evidence', async () => {
  const { options } = await fixture();
  await assert.rejects(validateLocalPullRequest({ ...options, command: 'exit 12' }), /code 12/);
  await assert.rejects(validateLocalPullRequest({ ...options, command: 'echo dirty >> app.txt' }), /clean workspace/);
});

test('rejects stale local or remote commits before running checks', async () => {
  const { options, remote } = await fixture();
  await assert.rejects(validateLocalPullRequest({ ...options, pullRequest: { ...options.pullRequest, head_sha: options.pullRequest.base_sha } }), /head does not match/);
  execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/main', options.pullRequest.head_sha!]);
  await assert.rejects(validateLocalPullRequest(options), /head or base changed/);
});

test('syncPullRequestWithBase merges a moved base into the branch, pushes, and validation then passes', async () => {
  const { options, remote, git } = await fixture();
  const workspacePath = options.workspacePath;
  // Advance the remote base with a non-conflicting commit while the branch sits where it was.
  const scratch = path.join(path.dirname(workspacePath), 'other');
  execFileSync('git', ['clone', '-q', remote, scratch], { stdio: 'ignore' });
  const other = (...args: string[]) => execFileSync('git', args, { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  other('config', 'user.name', 'Test'); other('config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(scratch, 'other.txt'), 'main moved');
  other('add', 'other.txt'); other('commit', '-qm', 'main moved'); other('push', '-q', 'origin', 'main');
  const movedBase = other('rev-parse', 'HEAD');

  const untouched = await syncPullRequestWithBase({ ...options, pullRequest: { ...options.pullRequest, base_sha: options.pullRequest.base_sha } });
  assert.equal(untouched.updated, true, 'the branch was behind the moved base');
  assert.equal(untouched.base_sha, movedBase);
  assert.equal(git('rev-parse', 'HEAD'), untouched.head_sha);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/symphony-1'], { encoding: 'utf8' }).trim(), untouched.head_sha, 'merge commit was pushed');
  execFileSync('git', ['merge-base', '--is-ancestor', movedBase, 'HEAD'], { cwd: workspacePath });

  const again = await syncPullRequestWithBase({ ...options, pullRequest: { ...options.pullRequest, head_sha: untouched.head_sha } });
  assert.equal(again.updated, false, 'already up to date');

  const evidence = await validateLocalPullRequest({ ...options, pullRequest: { ...options.pullRequest, head_sha: untouched.head_sha, base_sha: movedBase } });
  assert.equal(evidence.kind, 'validation');
});

test('syncPullRequestWithBase restores the workspace and reports conflicts', async () => {
  const { options, remote, git } = await fixture();
  const scratch = path.join(path.dirname(options.workspacePath), 'other');
  execFileSync('git', ['clone', '-q', remote, scratch], { stdio: 'ignore' });
  const other = (...args: string[]) => execFileSync('git', args, { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  other('config', 'user.name', 'Test'); other('config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(scratch, 'app.txt'), 'conflicting main change');
  other('commit', '-qam', 'conflict'); other('push', '-q', 'origin', 'main');

  await assert.rejects(syncPullRequestWithBase(options), (error: unknown) => error instanceof PullRequestConflictError && /app\.txt/.test(error.message));
  assert.equal(git('rev-parse', 'HEAD'), options.pullRequest.head_sha, 'head untouched');
  assert.equal(git('status', '--porcelain'), '', 'merge aborted cleanly');
  assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/symphony-1'], { encoding: 'utf8' }).trim(), options.pullRequest.head_sha, 'nothing pushed');
});

test('rejects a base moving during validation', async () => {
  const { options, remote } = await fixture();
  await assert.rejects(validateLocalPullRequest({ ...options, command: `git --git-dir='${remote}' update-ref refs/heads/main ${options.pullRequest.head_sha}` }), /head or base changed/);
});

test('orchestrator validates without review, respects pauses, invalidates failures, and recovers interrupted finalization', async () => {
  const { root, remote, options } = await fixture();
  const workflowPath = path.join(root, 'WORKFLOW.md');
  await fs.writeFile(workflowPath, `---
tracker:
  kind: github
  owner: example
  repo: app
  token: token
  api_base_url: https://api.github.test
  branch_prefix: symphony
workspace:
  root: ${root}
review:
  enabled: false
  shepherd_pull_requests: false
merge:
  enabled: true
  required_reviews: 0
  require_checks: false
  validation_command: echo checked
agents:
  default: codex
  providers:
    codex:
      command: echo unused
---
Prompt.
`);
  const { config } = await loadWorkflowFromFile(workflowPath);
  const p = options.pullRequest;
  const prPayload = { ...p, head: { ref: p.head_ref, sha: p.head_sha }, base: { ref: p.base_ref, sha: p.base_sha }, draft: false, mergeable_state: 'clean' };
  let stateComment = '';
  let issueLabels: string[] = [];
  let mergeCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/pulls?state=open&per_page=50')) return json([prPayload]);
    if (url.endsWith('/pulls/2')) return json(prPayload);
    if (url.endsWith('/issues/1/labels') && method === 'POST') {
      issueLabels = [...new Set([...issueLabels, ...JSON.parse(String(init?.body)).labels])];
      return json(issueLabels.map(name => ({ name })));
    }
    if (url.includes('/issues/1/labels/') && method === 'DELETE') {
      issueLabels = issueLabels.filter(label => label !== decodeURIComponent(url.split('/').at(-1)!));
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/issues/1')) return json({ id: 1, number: 1, title: 'Change', state: 'open', labels: issueLabels.map(name => ({ name })) });
    if (url.endsWith('/issues/2/comments?per_page=50')) return json(stateComment ? [{ id: 1, body: stateComment }] : []);
    if ((url.endsWith('/issues/2/comments') && method === 'POST') || (url.endsWith('/issues/comments/1') && method === 'PATCH')) {
      stateComment = JSON.parse(String(init?.body)).body;
      return json({ id: 1, body: stateComment });
    }
    if (url.endsWith('/pulls/2/files?per_page=50')) return json([{ filename: 'app.txt' }]);
    if (url.includes('/check-runs?')) return json({ check_runs: [] });
    if (url.endsWith('/status')) return json({ statuses: [] });
    if (url.endsWith('/pulls/2/merge') && method === 'PUT') {
      assert.equal(JSON.parse(String(init?.body)).sha, p.head_sha);
      mergeCount++;
      return json({ merged: true, sha: 'merge-sha', message: 'merged' });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
  const orchestrator = new Orchestrator({ workflowPath, repoId: 'app' });
  const internal = orchestrator as unknown as {
    recordLocalValidation(config: WorkflowConfig, issue: Issue, pr: PullRequestRef, workspace: string): Promise<boolean>;
    reconcileAutonomousMerges(config: WorkflowConfig, github: GithubIssueTrackerClient): Promise<void>;
    recoverFinalizingRuns(config: WorkflowConfig, github: GithubIssueTrackerClient): Promise<void>;
  };
  try {
    const issue = await new GithubIssueTrackerClient(config.tracker).fetchIssueByNumber(1);
    assert.ok(issue);
    await internal.reconcileAutonomousMerges(config, new GithubIssueTrackerClient(config.tracker));
    assert.equal(mergeCount, 0, 'no validation receipt must not merge');
    await internal.recordLocalValidation(config, issue, p, options.workspacePath);
    assert.match(stateComment, /local-validation/);
    assert.doesNotMatch(stateComment, /"kind": "review"/);
    issueLabels = ['needs-info'];
    await internal.reconcileAutonomousMerges(config, new GithubIssueTrackerClient(config.tracker));
    assert.equal(mergeCount, 0, 'a paused issue must not merge');
    issueLabels = [];
    await internal.reconcileAutonomousMerges(config, new GithubIssueTrackerClient(config.tracker));
    assert.equal(mergeCount, 1);
    const failing = { ...config, merge: { ...config.merge, validation_command: 'exit 12' } };
    assert.equal(await internal.recordLocalValidation(failing, issue, p, options.workspacePath), false);
    assert.match(stateComment, /"verdict": "error"/);
    assert.match(stateComment, /code 12/);
    await internal.reconcileAutonomousMerges(config, new GithubIssueTrackerClient(config.tracker));
    assert.equal(mergeCount, 1, 'an old successful receipt must not survive a failed rerun');
    const marker = path.join(root, 'validation-attempted');
    const retryable = { ...config, merge: { ...config.merge, validation_command:
      `if [ ! -f '${marker}' ]; then touch '${marker}'; exit 12; fi` } };
    assert.equal(await internal.recordLocalValidation(retryable, issue, p, options.workspacePath), true);
    await writeRunState(options.workspacePath, {
      repo_id: 'app', owner: 'example', repo: 'app', issue_id: issue.id, issue_number: 1,
      issue_identifier: issue.identifier, issue_url: issue.url, workspace_path: options.workspacePath,
      attempt: 1, session_id: 'interrupted-run', codex_thread_id: null, codex_mode: 'autonomous',
      pause_reason: null, worker_pid: null, status: 'finalizing', started_at: null, finished_at: null,
      last_exit_code: 0, last_signal: null, last_error: null, prompt_path: null, codex_jsonl_path: null,
      last_message_path: null, last_seen_comment_id: null, status_comment_id: null, last_handoff_at: null,
      updated_at: new Date().toISOString(), finalization_step: 'hook-completed',
      finalization_context: {
        mode: 'autonomous', review_pr: { pr_number: 2, pr_url: null, head_ref: p.head_ref, head_sha: p.head_sha,
          base_ref: p.base_ref, base_sha: p.base_sha, originating_issue_number: 1, review_key: 'unused', lens: 'unused' },
      },
    });
    issueLabels = ['agent-running'];
    await internal.recoverFinalizingRuns(config, new GithubIssueTrackerClient(config.tracker));
    assert.equal((await readRunState(options.workspacePath))?.status, 'completed');
    assert.ok(!issueLabels.includes('agent-running'), 'recovery must release the running label before merging');
    await internal.reconcileAutonomousMerges(config, new GithubIssueTrackerClient(config.tracker));
    assert.equal(mergeCount, 2, 'recovered validation must become eligible without a review verdict');
    const movingBase = { ...config, merge: { ...config.merge, validation_command:
      `git --git-dir='${remote}' update-ref refs/heads/main ${p.head_sha}` } };
    assert.equal(await internal.recordLocalValidation(movingBase, issue, p, options.workspacePath), true);
    assert.match(stateComment, new RegExp(`"base_sha": "${p.head_sha}"`));
  } finally {
    globalThis.fetch = originalFetch;
    await orchestrator.shutdown('test');
  }
});
