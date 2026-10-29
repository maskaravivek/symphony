import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { Orchestrator } from './orchestrator.js';
import { GithubIssueTrackerClient } from '../github/githubClient.js';
import { loadWorkflowFromFile } from '../workflow/loadWorkflow.js';
import { ensureLinkedWorktree } from '../workspace/linkedWorktrees.js';
import type { Issue } from '../domain/issue.js';
import type { WorkflowConfig } from '../workflow/types.js';
import { readRunState, updateRunState, type RunState } from '../status/runState.js';

const execFileAsync = promisify(execFile);

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function issuePayload(number: number, title: string, state: string, labels: string[] = [], pullRequest = false) {
  return {
    id: number,
    node_id: `${pullRequest ? 'PR' : 'I'}_${number}`,
    number,
    title,
    state,
    labels: labels.map((name) => ({ name })),
    html_url: `https://github.test/mangoappstudio/mdedit/${pullRequest ? 'pull' : 'issues'}/${number}`,
    repository_url: 'https://api.github.test/repos/mangoappstudio/mdedit',
    ...(pullRequest ? { pull_request: {} } : {}),
  };
}

async function createOriginRepo(): Promise<string> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-origin-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, 'README.md'), 'main\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoPath });
  await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
  await execFileAsync('git', ['checkout', '-b', 'codex-77-review-follow-up'], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, 'README.md'), 'pr branch\n', 'utf8');
  await execFileAsync('git', ['commit', '-am', 'PR branch'], { cwd: repoPath });
  await execFileAsync('git', ['checkout', 'main'], { cwd: repoPath });
  return repoPath;
}

async function writeWorkflow(
  workspaceRoot: string,
  originRepo: string,
  opts: {
    native?: boolean;
    afterRun?: string;
    reviewConfig?: string;
    command?: string;
  } = {},
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-workflow-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  api_base_url: https://api.github.test
  active_states: [open]
  terminal_states: [closed]
  required_labels: [ready-for-agent]
  ignored_labels: [blocked, ready-for-human, wontfix]
  branch_prefix: codex
workspace:
  root: ${workspaceRoot}
${opts.native ? `  checkout:\n    kind: linked_worktree\n    source: ${originRepo}\n    base_branch: main\n  strategy:\n    implementation: pooled_isolated\n` : ''}${opts.reviewConfig ?? ''}
hooks:
  after_create: |
    ${opts.native ? 'exit 17' : `git clone ${originRepo} .`}
${opts.native ? '  before_run: exit 18' : ''}
${opts.afterRun ? `  after_run: |\n${opts.afterRun.split('\n').map((line) => `    ${line}`).join('\n')}\n` : ''}
agents:
  default: codex
  providers:
    codex:
      command: ${opts.command ?? "bash -lc 'echo addressed > .symphony/last_message.md'"}
      resume_command: bash -lc 'echo addressed > .symphony/last_message.md'
      handoff_command: bash -lc 'echo handoff > .symphony/last_message.md'
---

Prompt body
`,
    'utf8',
  );
  return workflowPath;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true);
}

function reviewStateComment(opts: {
  prNumber: number;
  issueNumber: number | null;
  headSha: string;
  verdict: 'pass' | 'block';
  autoFixIterations: number;
}): string {
  return `<!-- symphony-review-state:v1 -->
\`\`\`json
${JSON.stringify(
  {
    version: 1,
    pr_number: opts.prNumber,
    issue_number: opts.issueNumber,
    head_ref: 'codex-77-review-follow-up',
    head_sha: opts.headSha,
    base_ref: 'main',
    verdict: opts.verdict,
    auto_fix_iterations: opts.autoFixIterations,
    reviewed_at: '2026-07-08T00:00:00.000Z',
    reason: 'test',
  },
  null,
  2,
)}
\`\`\`
`;
}

for (const {native, blocking} of [{native:false, blocking:false}, {native:true, blocking:false}, {native:true, blocking:true}]) test(`dispatches ${blocking ? 'blocking' : 'non-blocking'} PR feedback using ${native ? 'the original warm linked worktree' : 'legacy hooks'}`, async t => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-workspace-'));
  const originRepo = await createOriginRepo();
  t.after(() => fs.rm(workspaceRoot, {recursive:true, force:true}));
  t.after(() => fs.rm(originRepo, {recursive:true, force:true}));
  if (native) {
    await fs.writeFile(path.join(originRepo, '.gitignore'), 'node_modules/\n.symphony/\n');
    await execFileAsync('git', ['add', '.gitignore'], {cwd:originRepo});
    await execFileAsync('git', ['commit', '-m', 'Ignore runtime files'], {cwd:originRepo});
    await execFileAsync('git', ['checkout', 'codex-77-review-follow-up'], {cwd:originRepo});
    await execFileAsync('git', ['merge', 'main'], {cwd:originRepo});
    await execFileAsync('git', ['checkout', 'main'], {cwd:originRepo});
    await execFileAsync('git', ['remote', 'add', 'origin', originRepo], {cwd:originRepo});
  }
  const headSha = native ? (await execFileAsync('git', ['rev-parse', 'codex-77-review-follow-up'], {cwd:originRepo})).stdout.trim() : 'reviewed-head';
  const workflowPath = await writeWorkflow(workspaceRoot, originRepo, {
    native,
    reviewConfig: `review:
  enabled: false`,
    afterRun: native ? (blocking ? 'echo validated > .symphony/validated' : 'exit 19') : `test "$SYMPHONY_REVIEW_ENABLED" = "0"
test -z "$SYMPHONY_REVIEW_PROMPT_PATH"`,
  });
  if (native) {
    const {config} = await loadWorkflowFromFile(workflowPath);
    const slot = path.join(workspaceRoot, '_pool_2');
    await ensureLinkedWorktree(config.workspace, slot);
    await execFileAsync('git', ['fetch', 'origin'], {cwd:slot});
    await execFileAsync('git', ['checkout', 'codex-77-review-follow-up'], {cwd:slot});
    await fs.mkdir(path.join(slot, 'node_modules'));
    await fs.writeFile(path.join(slot, 'node_modules', 'warm'), 'installed');
  }
  const baseSha = (await execFileAsync('git', ['rev-parse', 'main'], {cwd:originRepo})).stdout.trim();
  let reportedHeadSha = headSha;
  let orchestrator: Orchestrator | undefined;
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  let feedbackStateComment = `<!-- symphony-pr-feedback-state:v1 -->
\`\`\`json
${JSON.stringify({
  version: 1,
  pr_number: 77,
  last_issue_comment_id: null,
  last_review_comment_id: 901,
  pending: true,
  feedback_round: 1,
  observed_head_sha: headSha,
  priorities: [blocking ? 'p1' : 'p2'],
  has_blocking_feedback: blocking,
  exhausted: false,
  updated_at: '2026-07-10T00:00:00.000Z',
})}
\`\`\``;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([issuePayload(77, 'Review follow-up', 'open', ['ready-for-agent'], true)]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77') {
      return jsonResponse(issuePayload(77, 'Review follow-up', 'open', ['agent-running'], true));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77') {
      return jsonResponse({
        number: 77,
        title: 'Review follow-up',
        body: 'Fixes #42',
        state: 'open',
        draft: false,
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        head: { ref: 'codex-77-review-follow-up', sha: reportedHeadSha },
        base: { ref: 'main', sha: baseSha },
        mergeable_state: 'clean',
      });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments?per_page=50') {
      return jsonResponse([
        { id: 900, body: reviewStateComment({ prNumber: 77, issueNumber: 42, headSha, verdict: 'pass', autoFixIterations: 0 }) },
        { id: 902, body: feedbackStateComment },
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77/comments?per_page=50') {
      return jsonResponse([
        {
          id: 901,
          body: 'Please add the retry case.',
          html_url: 'https://github.test/comment/901',
          created_at: '2026-07-05T12:00:00Z',
          updated_at: '2026-07-05T12:00:00Z',
          user: { login: 'reviewer' },
        },
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments' && method === 'POST') {
      return jsonResponse({ id: 501, body: String(body), html_url: 'https://github.test/comment/501' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/501' && method === 'PATCH') {
      return jsonResponse({ id: 501, body: String(body), html_url: 'https://github.test/comment/501' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/902' && method === 'PATCH') {
      feedbackStateComment = body.body;
      return jsonResponse({ id: 902, body: String(body), html_url: 'https://github.test/comment/902' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/900' && method === 'PATCH') {
      return jsonResponse({ id: 900, body: String(body), html_url: 'https://github.test/comment/900' });
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    orchestrator = new Orchestrator({ workflowPath });
    t.after(() => orchestrator!.shutdown('test'));
    await orchestrator.tickOnce();
    await waitFor(() =>
      calls.some(
        (call) =>
          call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' &&
          call.method === 'POST' &&
          JSON.stringify(call.body) === JSON.stringify({ labels: ['ready-for-human'] }),
      ),
    );
    await orchestrator.shutdown('test');
  } finally {
    if (!native) globalThis.fetch = originalFetch;
    else t.after(() => {globalThis.fetch = originalFetch;});
  }

  const selected = path.join(workspaceRoot, native ? '_pool_2' : 'mangoappstudio_mdedit_77');
  if (native) {
    assert.equal(await fs.readFile(path.join(selected, 'node_modules', 'warm'), 'utf8'), 'installed');
    assert.equal((await readRunState(selected))?.status, 'completed');
    assert.equal((await execFileAsync('git', ['rev-parse', 'HEAD'], {cwd:selected})).stdout.trim(), headSha);
    const state = await readRunState(selected);
    assert.equal(await fs.readFile(state!.last_message_path!, 'utf8'), blocking ? 'addressed\n' : 'handoff\n');
    if (blocking) {
      assert.equal(await fs.readFile(path.join(selected, '.symphony', 'validated'), 'utf8'), 'validated\n');
    } else {
      assert.equal(state?.followup_worktree_status, '');
      const finalizer = orchestrator! as unknown as {
        finishFollowupReview(config:WorkflowConfig, issue:Issue, state:RunState):Promise<void>;
        recoverFinalizingRuns(config:WorkflowConfig, client:GithubIssueTrackerClient):Promise<void>;
      };
      const {config} = await loadWorkflowFromFile(workflowPath);
      const issue:Issue = {id:'77', identifier:'mangoappstudio/mdedit#77', number:77, title:'Review follow-up', description:'',
        priority:null, state:'open', labels:[], assignees:[], milestone:null, blocked_by:[], pull_requests:[], workflow_state:null,
        branch_name:'codex-77-review-follow-up', created_at:null, updated_at:null, ready_for_agent_labeled_at:null, url:null};
      await fs.writeFile(path.join(selected, 'README.md'), 'unexpected code edit');
      await assert.rejects(finalizer.finishFollowupReview(config, issue, state!), /changed the checkout/);
      await execFileAsync('git', ['restore', 'README.md'], {cwd:selected});
      reportedHeadSha = 'new-remote-head';
      await assert.rejects(finalizer.finishFollowupReview(config, issue, state!), /head or base changed/);
      reportedHeadSha = headSha;
      const savedFeedback = feedbackStateComment;
      feedbackStateComment = feedbackStateComment.replace(/"last_review_comment_id":\s*901/, '"last_review_comment_id":999');
      await assert.rejects(finalizer.finishFollowupReview(config, issue, state!), /New feedback/);
      feedbackStateComment = savedFeedback;
      const receiptsBefore = calls.filter(call => call.url.endsWith('/issues/comments/900') && call.method === 'PATCH').length;
      await updateRunState(selected, cur => cur ? {...cur, status:'finalizing'} : null);
      await finalizer.recoverFinalizingRuns(config, new GithubIssueTrackerClient(config.tracker));
      assert.equal((await readRunState(selected))?.status, 'completed');
      assert.equal(calls.filter(call => call.url.endsWith('/issues/comments/900') && call.method === 'PATCH').length, receiptsBefore);
    }
  }
  const prompt = await fs.readFile(path.join(selected, '.symphony', 'prompt.md'), 'utf8');
  assert.match(prompt, /Pull Request Review Instructions/);
  assert.match(prompt, /Please add the retry case\./);
  await assert.rejects(() => fs.access(path.join(selected, '.symphony', 'review_prompt.md')));
  if (!blocking) assert.ok(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' &&
        call.method === 'POST' &&
        JSON.stringify(call.body) === JSON.stringify({ labels: ['symphony-review:passed', 'ready-for-human'] }),
    ),
  );
  if (!blocking) assert.ok(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/900' &&
        call.method === 'PATCH' &&
        /external-review-policy/.test(JSON.stringify(call.body)),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/902' &&
        call.method === 'PATCH' &&
        /pending.*false/.test(JSON.stringify(call.body)),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' &&
        call.method === 'POST' &&
        JSON.stringify(call.body) === JSON.stringify({ labels: ['agent-running'] }),
    ),
  );
});

test('skips PR review dispatch when the current head SHA already passed review', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-skip-passed-workspace-'));
  const originRepo = await createOriginRepo();
  const workflowPath = await writeWorkflow(workspaceRoot, originRepo);
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([issuePayload(77, 'Review follow-up', 'open', ['ready-for-agent'], true)]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77') {
      return jsonResponse({
        number: 77,
        title: 'Review follow-up',
        body: 'Fixes #42',
        state: 'open',
        draft: false,
        labels: [],
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        head: { ref: 'codex-77-review-follow-up', sha: 'reviewed-head' },
        base: { ref: 'main' },
        mergeable_state: 'clean',
      });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments?per_page=50') {
      return jsonResponse([{ id: 900, body: reviewStateComment({ prNumber: 77, issueNumber: 42, headSha: 'reviewed-head', verdict: 'pass', autoFixIterations: 0 }) }]);
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.some((call) => call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' && call.method === 'POST'), false);
});

test('labels PR passed when post-run review passes', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-pass-workspace-'));
  const originRepo = await createOriginRepo();
  const workflowPath = await writeWorkflow(workspaceRoot, originRepo, {
    afterRun: `printf '%s\\n' 'SYMPHONY_REVIEW_RESULT: {"verdict":"pass","summary":"looks good","findings":[]}'`,
  });
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([issuePayload(42, 'Implementation', 'open', ['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([
        {
          number: 77,
          title: 'Implementation',
          body: 'Fixes #42',
          state: 'open',
          draft: false,
        labels: [],
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        head: { ref: 'codex-77-review-follow-up', sha: 'head-sha-pass' },
        base: { ref: 'main' },
        mergeable_state: 'clean',
      },
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42') {
      return jsonResponse(issuePayload(42, 'Implementation', 'open', ['agent-running']));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77') {
      return jsonResponse({
        number: 77,
        title: 'Implementation',
        body: 'Fixes #42',
        state: 'open',
        draft: false,
        labels: [],
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        head: { ref: 'codex-77-review-follow-up', sha: 'head-sha-pass' },
        base: { ref: 'main' },
        mergeable_state: 'clean',
      });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments' && method === 'POST') {
      return jsonResponse({ id: 771, body: body && typeof body === 'object' && 'body' in body ? String(body.body) : '', html_url: 'https://github.test/comment/771' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments' && method === 'POST') {
      return jsonResponse({ id: 601, body: String(body), html_url: 'https://github.test/comment/601' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/601' && method === 'PATCH') {
      return jsonResponse({ id: 601, body: String(body), html_url: 'https://github.test/comment/601' });
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await waitFor(() =>
      calls.some(
        (call) =>
          call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' &&
          call.method === 'POST' &&
          JSON.stringify(call.body) === JSON.stringify({ labels: ['symphony-review:passed', 'ready-for-human'] }),
      ),
    );
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const reviewPrompt = await fs.readFile(path.join(workspaceRoot, 'mangoappstudio_mdedit_42', '.symphony', 'review_prompt.md'), 'utf8');
  assert.match(reviewPrompt, /\/code-review/);
  assert.match(reviewPrompt, /staff engineer/);
  assert.match(reviewPrompt, /Review lens: `staff-engineer`/);
  assert.match(reviewPrompt, /SYMPHONY_REVIEW_RESULT/);
  assert.doesNotMatch(reviewPrompt, /REVIEW_VERDICT/);
  assert.ok(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments' &&
        call.method === 'POST' &&
        typeof call.body === 'object' &&
        call.body !== null &&
        'body' in call.body &&
        typeof call.body.body === 'string' &&
        call.body.body.includes('"head_sha": "head-sha-pass"') &&
        call.body.body.includes('"verdict": "pass"'),
    ),
  );
});

test('does not mark PR review passed when after_run emits no verdict', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-no-verdict-workspace-'));
  const originRepo = await createOriginRepo();
  const workflowPath = await writeWorkflow(workspaceRoot, originRepo, {
    afterRun: 'printf "generic validation succeeded\\n"',
  });
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([issuePayload(42, 'Implementation', 'open', ['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([
        {
          number: 77,
          title: 'Implementation',
          body: 'Fixes #42',
          state: 'open',
          draft: false,
        labels: [],
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        head: { ref: 'codex-77-review-follow-up', sha: 'head-sha-block' },
        base: { ref: 'main' },
        mergeable_state: 'clean',
      },
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42') {
      return jsonResponse(issuePayload(42, 'Implementation', 'open', ['agent-running']));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77') {
      return jsonResponse({
        number: 77,
        title: 'Implementation',
        body: 'Fixes #42',
        state: 'open',
        draft: false,
        labels: [],
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        head: { ref: 'codex-77-review-follow-up', sha: 'head-sha-block' },
        base: { ref: 'main' },
        mergeable_state: 'clean',
      });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments' && method === 'POST') {
      return jsonResponse({ id: 772, body: body && typeof body === 'object' && 'body' in body ? String(body.body) : '', html_url: 'https://github.test/comment/772' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments' && method === 'POST') {
      return jsonResponse({ id: 651, body: String(body), html_url: 'https://github.test/comment/651' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/651' && method === 'PATCH') {
      return jsonResponse({ id: 651, body: String(body), html_url: 'https://github.test/comment/651' });
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await waitFor(() =>
      calls.some(
        (call) =>
          call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels' &&
          call.method === 'POST' &&
          JSON.stringify(call.body) === JSON.stringify({ labels: ['ready-for-human'] }),
      ),
    );
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(
    !calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' &&
        call.method === 'POST' &&
        JSON.stringify(call.body) === JSON.stringify({ labels: ['symphony-review:passed', 'ready-for-human'] }),
    ),
  );
});

test('queues one PR auto-fix iteration when post-run review blocks', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-block-workspace-'));
  const originRepo = await createOriginRepo();
  const workflowPath = await writeWorkflow(workspaceRoot, originRepo, {
    reviewConfig: `review:
  auto_fix_review_comments: true
  number_of_auto_fix_iterations: 1`,
    afterRun: `printf '%s\\n' 'SYMPHONY_REVIEW_RESULT: {"verdict":"block","summary":"needs work","findings":[{"disposition":"actionable","severity":"high","summary":"needs work","file":null,"line":null}]}' ; exit 1`,
  });
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([issuePayload(42, 'Implementation', 'open', ['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([
        {
          number: 77,
          title: 'Implementation',
          body: 'Fixes #42',
          state: 'open',
          draft: false,
        labels: [],
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        head: { ref: 'codex-77-review-follow-up', sha: 'head-sha-block' },
        base: { ref: 'main' },
        mergeable_state: 'clean',
      },
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42') {
      return jsonResponse(issuePayload(42, 'Implementation', 'open', ['agent-running']));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77') {
      return jsonResponse({
        number: 77,
        title: 'Implementation',
        body: 'Fixes #42',
        state: 'open',
        draft: false,
        labels: [],
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        head: { ref: 'codex-77-review-follow-up', sha: 'head-sha-block' },
        base: { ref: 'main' },
        mergeable_state: 'clean',
      });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments' && method === 'POST') {
      return jsonResponse({ id: 772, body: body && typeof body === 'object' && 'body' in body ? String(body.body) : '', html_url: 'https://github.test/comment/772' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments' && method === 'POST') {
      return jsonResponse({ id: 701, body: String(body), html_url: 'https://github.test/comment/701' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/701' && method === 'PATCH') {
      return jsonResponse({ id: 701, body: String(body), html_url: 'https://github.test/comment/701' });
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await waitFor(() =>
      calls.some(
        (call) =>
          call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' &&
          call.method === 'POST' &&
          JSON.stringify(call.body) === JSON.stringify({ labels: ['symphony-review:blocking', 'ready-for-agent', 'symphony-review:auto-fix-1'] }),
      ),
    );
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels/ready-for-human' &&
        call.method === 'DELETE',
    ),
  );
  assert.ok(
    !calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels' &&
        call.method === 'POST' &&
        JSON.stringify(call.body) === JSON.stringify({ labels: ['ready-for-agent'] }),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments' &&
        call.method === 'POST' &&
        typeof call.body === 'object' &&
        call.body !== null &&
        'body' in call.body &&
        typeof call.body.body === 'string' &&
        call.body.body.includes('"head_sha": "head-sha-block"') &&
        call.body.body.includes('"verdict": "block"') &&
        call.body.body.includes('"auto_fix_iterations": 1'),
    ),
  );
});

test('waits for human when a blocking review repeats on the same PR head SHA', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-same-head-block-workspace-'));
  const originRepo = await createOriginRepo();
  const workflowPath = await writeWorkflow(workspaceRoot, originRepo, {
    reviewConfig: `review:
  auto_fix_review_comments: true
  number_of_auto_fix_iterations: 3`,
    afterRun: `printf '%s\\n' 'SYMPHONY_REVIEW_RESULT: {"verdict":"block","summary":"still the same problem","findings":[{"disposition":"actionable","severity":"high","summary":"still the same problem","file":null,"line":null}]}' ; exit 1`,
  });
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([issuePayload(77, 'Review follow-up', 'open', ['ready-for-agent', 'symphony-review:blocking', 'symphony-review:auto-fix-1'], true)]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77') {
      return jsonResponse(issuePayload(77, 'Review follow-up', 'open', ['agent-running', 'symphony-review:blocking', 'symphony-review:auto-fix-1'], true));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77') {
      return jsonResponse({
        number: 77,
        title: 'Review follow-up',
        body: 'Fixes #42',
        state: 'open',
        draft: false,
        labels: ['ready-for-agent', 'symphony-review:blocking', 'symphony-review:auto-fix-1'].map((name) => ({ name })),
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        head: { ref: 'codex-77-review-follow-up', sha: 'same-blocked-head' },
        base: { ref: 'main' },
        mergeable_state: 'clean',
      });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments?per_page=50') {
      return jsonResponse([
        {
          id: 900,
          body: reviewStateComment({ prNumber: 77, issueNumber: 42, headSha: 'same-blocked-head', verdict: 'block', autoFixIterations: 1 }),
        },
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/900' && method === 'PATCH') {
      return jsonResponse({ id: 900, body: body && typeof body === 'object' && 'body' in body ? String(body.body) : '', html_url: 'https://github.test/comment/900' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments' && method === 'POST') {
      return jsonResponse({ id: 901, body: String(body), html_url: 'https://github.test/comment/901' });
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await waitFor(() =>
      calls.some(
        (call) =>
          call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' &&
          call.method === 'POST' &&
          JSON.stringify(call.body) === JSON.stringify({ labels: ['symphony-review:blocking', 'ready-for-human'] }),
      ),
    );
    await waitFor(() => calls.some((call) => call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments' && call.method === 'POST'));
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' &&
        call.method === 'POST' &&
        JSON.stringify(call.body) === JSON.stringify({ labels: ['symphony-review:blocking', 'ready-for-agent', 'symphony-review:auto-fix-2'] }),
    ),
    false,
  );
});

test('marks PR ready for human when blocking review exhausts auto-fix iterations', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-exhausted-workspace-'));
  const originRepo = await createOriginRepo();
  const workflowPath = await writeWorkflow(workspaceRoot, originRepo, {
    reviewConfig: `review:
  auto_fix_review_comments: true
  number_of_auto_fix_iterations: 1`,
    afterRun: `printf '%s\\n' 'SYMPHONY_REVIEW_RESULT: {"verdict":"block","summary":"still blocked","findings":[{"disposition":"actionable","severity":"high","summary":"still blocked","file":null,"line":null}]}' ; exit 1`,
  });
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([issuePayload(77, 'Review follow-up', 'open', ['ready-for-agent', 'symphony-review:blocking', 'symphony-review:auto-fix-1'], true)]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77') {
      return jsonResponse(issuePayload(77, 'Review follow-up', 'open', ['agent-running', 'symphony-review:blocking', 'symphony-review:auto-fix-1'], true));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77') {
      return jsonResponse({
        number: 77,
        title: 'Review follow-up',
        body: 'Fixes #42',
        state: 'open',
        draft: false,
        labels: ['ready-for-agent', 'symphony-review:blocking', 'symphony-review:auto-fix-1'].map((name) => ({ name })),
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        head: { ref: 'codex-77-review-follow-up' },
        base: { ref: 'main' },
        mergeable_state: 'clean',
      });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/comments' && method === 'POST') {
      return jsonResponse({ id: 801, body: String(body), html_url: 'https://github.test/comment/801' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/801' && method === 'PATCH') {
      return jsonResponse({ id: 801, body: String(body), html_url: 'https://github.test/comment/801' });
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await waitFor(() =>
      calls.some(
        (call) =>
          call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' &&
          call.method === 'POST' &&
          JSON.stringify(call.body) === JSON.stringify({ labels: ['symphony-review:blocking', 'ready-for-human'] }),
      ),
    );
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels' &&
        call.method === 'POST' &&
        JSON.stringify(call.body) === JSON.stringify({ labels: ['symphony-review:blocking', 'ready-for-human'] }),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/77/labels/ready-for-agent' &&
        call.method === 'DELETE',
    ),
  );
});
