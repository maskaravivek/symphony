import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GithubIssueTrackerClient } from '../github/githubClient.js';
import { loadWorkflowFromFile } from '../workflow/loadWorkflow.js';
import type { WorkflowConfig } from '../workflow/types.js';
import { Orchestrator } from './orchestrator.js';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('queues a Symphony PR for external review feedback without Symphony review state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-shepherd-'));
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
  root: ${path.join(root, 'workspaces')}
review:
  enabled: false
  shepherd_pull_requests: true
codex:
  command: echo unused
---
Prompt.
`, 'utf8');
  const { config } = await loadWorkflowFromFile(workflowPath);
  const pr = {
    number: 42,
    title: 'Fix',
    body: 'Fixes #17',
    state: 'open',
    draft: false,
    labels: [{ name: 'ready-for-human' }],
    html_url: 'https://github.test/example/app/pull/42',
    head: { ref: 'symphony-17-fix', sha: 'head' },
    base: { ref: 'main', sha: 'base' },
    mergeable_state: 'clean',
  };
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.endsWith('/pulls?state=open&per_page=50')) return jsonResponse([pr]);
    if (url.endsWith('/issues/42/comments?per_page=50')) {
      return jsonResponse([{ id: 12, body: '[P3] Please update the PR summary.', user: { login: 'reviewer' } }]);
    }
    if (url.endsWith('/pulls/42/comments?per_page=50')) {
      return jsonResponse([{ id: 11, body: '**P2 Badge** Please cover the empty state.', user: { login: 'chatgpt-codex-connector[bot]' } }]);
    }
    if (url.endsWith('/issues/42/reactions?per_page=50')) return jsonResponse([]);
    if (url.endsWith('/issues/42/comments') && method === 'POST') return jsonResponse({ id: 13, body: String(body) });
    if (url.endsWith('/issues/42/labels') && method === 'POST') return jsonResponse([]);
    if (url.endsWith('/issues/42/labels/ready-for-human') && method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath, repoId: 'app' });
    const shepherd = orchestrator as unknown as {
      reconcilePullRequestFeedback(config: WorkflowConfig, tracker: GithubIssueTrackerClient): Promise<void>;
    };
    await shepherd.reconcilePullRequestFeedback(config, new GithubIssueTrackerClient(config.tracker));
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(calls.some((call) => call.url.endsWith('/issues/42/labels') && call.method === 'POST'));
  const stateUpdate = calls.find((call) => call.url.endsWith('/issues/42/comments') && call.method === 'POST');
  assert.match(JSON.stringify(stateUpdate?.body), /symphony-pr-feedback-state:v1/);
  assert.match(JSON.stringify(stateUpdate?.body), /last_issue_comment_id.*12/);
  assert.match(JSON.stringify(stateUpdate?.body), /last_review_comment_id.*11/);
  assert.match(JSON.stringify(stateUpdate?.body), /pending.*true/);
  assert.match(JSON.stringify(stateUpdate?.body), /feedback_round.*1/);
  assert.match(JSON.stringify(stateUpdate?.body), /blocking_feedback_round.*0/);
  assert.match(JSON.stringify(stateUpdate?.body), /has_blocking_feedback.*false/);
});

test('stops retrying blocking external feedback after the configured round limit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-shepherd-exhausted-'));
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
  root: ${path.join(root, 'workspaces')}
review:
  enabled: false
  shepherd_pull_requests: true
  max_feedback_rounds: 1
codex:
  command: echo unused
---
Prompt.
`, 'utf8');
  const { config } = await loadWorkflowFromFile(workflowPath);
  const feedbackState = `<!-- symphony-pr-feedback-state:v1 -->\n\`\`\`json\n${JSON.stringify({
    version: 1,
    pr_number: 42,
    last_issue_comment_id: null,
    last_review_comment_id: 10,
    pending: false,
    feedback_round: 1,
    observed_head_sha: 'head',
    priorities: ['p1'],
    has_blocking_feedback: true,
    exhausted: false,
    updated_at: '2026-07-10T00:00:00Z',
  })}\n\`\`\``;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.endsWith('/pulls?state=open&per_page=50')) {
      return jsonResponse([{
        number: 42,
        title: 'Fix',
        body: 'Fixes #17',
        state: 'open',
        draft: false,
        labels: [],
        html_url: 'https://github.test/example/app/pull/42',
        head: { ref: 'symphony-17-fix', sha: 'head' },
        base: { ref: 'main', sha: 'base' },
        mergeable_state: 'clean',
      }]);
    }
    if (url.endsWith('/issues/42/comments?per_page=50')) return jsonResponse([{ id: 1, body: feedbackState }]);
    if (url.endsWith('/pulls/42/comments?per_page=50')) return jsonResponse([{ id: 11, body: '[P1] Still broken.' }]);
    if (url.endsWith('/issues/42/reactions?per_page=50')) return jsonResponse([]);
    if (url.endsWith('/issues/42/labels') && method === 'POST') return jsonResponse([]);
    if (url.endsWith('/issues/42/labels/ready-for-agent') && method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/issues/42/labels/agent-running') && method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/issues/42/labels/symphony-review%3Apassed') && method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/issues/comments/1') && method === 'PATCH') return jsonResponse({ id: 1, body: String(body) });
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath, repoId: 'app' });
    const shepherd = orchestrator as unknown as {
      reconcilePullRequestFeedback(config: WorkflowConfig, tracker: GithubIssueTrackerClient): Promise<void>;
    };
    await shepherd.reconcilePullRequestFeedback(config, new GithubIssueTrackerClient(config.tracker));
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(calls.some(
    (call) =>
      call.url.endsWith('/issues/42/labels') &&
      JSON.stringify(call.body) === JSON.stringify({ labels: ['ready-for-human', 'symphony-review:blocking'] }),
  ));
  const stateUpdate = calls.find((call) => call.url.endsWith('/issues/comments/1') && call.method === 'PATCH');
  assert.match(JSON.stringify(stateUpdate?.body), /feedback_round.*2/);
  assert.match(JSON.stringify(stateUpdate?.body), /blocking_feedback_round.*2/);
  assert.match(JSON.stringify(stateUpdate?.body), /exhausted.*true/);
  assert.match(JSON.stringify(stateUpdate?.body), /pending.*false/);
});

test('treats a fresh Codex thumbs-up on the current head as passing external review', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-shepherd-codex-pass-'));
  const workspaceRoot = path.join(root, 'workspaces');
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
  root: ${workspaceRoot}
review:
  enabled: false
  shepherd_pull_requests: true
codex:
  command: echo unused
---
Prompt.
`, 'utf8');
  const { config } = await loadWorkflowFromFile(workflowPath);
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.endsWith('/pulls?state=open&per_page=50')) {
      return jsonResponse([{
        number: 42,
        title: 'Fix',
        body: 'Fixes #17',
        state: 'open',
        draft: false,
        labels: [{ name: 'ready-for-human' }],
        html_url: 'https://github.test/example/app/pull/42',
        head: { ref: 'symphony-17-fix', sha: 'head' },
        base: { ref: 'main', sha: 'base' },
        mergeable_state: 'clean',
      }]);
    }
    if (url.endsWith('/issues/42/comments?per_page=50')) return jsonResponse([]);
    if (url.endsWith('/pulls/42/comments?per_page=50')) return jsonResponse([]);
    if (url.endsWith('/issues/42/reactions?per_page=50')) {
      return jsonResponse([{ id: 91, content: '+1', created_at: '2026-07-17T04:19:12Z', user: { login: 'chatgpt-codex-connector[bot]' } }]);
    }
    if (url.endsWith('/pulls/42/commits?per_page=50')) {
      return jsonResponse([{ sha: 'head', commit: { committer: { date: '2026-07-17T04:15:28Z' } } }]);
    }
    if (url.endsWith('/issues/17')) {
      return jsonResponse({
        id: 17,
        node_id: 'I_17',
        number: 17,
        title: 'Fix',
        state: 'open',
        labels: [],
        html_url: 'https://github.test/example/app/issues/17',
        repository_url: 'https://api.github.test/repos/example/app',
      });
    }
    if (url.endsWith('/issues/42/comments') && method === 'POST') return jsonResponse({ id: 92, body: String(body) });
    if (url.endsWith('/issues/42/labels') && method === 'POST') return jsonResponse([]);
    if (url.startsWith('https://api.github.test/repos/example/app/issues/42/labels/') && method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath, repoId: 'app' });
    const shepherd = orchestrator as unknown as {
      reconcilePullRequestFeedback(config: WorkflowConfig, tracker: GithubIssueTrackerClient): Promise<void>;
    };
    await shepherd.reconcilePullRequestFeedback(config, new GithubIssueTrackerClient(config.tracker));
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const reviewState = calls.find(
    (call) => call.url.endsWith('/issues/42/comments') && call.method === 'POST' && /symphony-review-state:v1/.test(JSON.stringify(call.body)),
  );
  assert.match(JSON.stringify(reviewState?.body), /github-codex/);
  assert.match(JSON.stringify(reviewState?.body), /verdict[^]*pass/);
  assert.ok(!calls.some((call) => call.url.endsWith('/issues/42/labels') && /ready-for-agent/.test(JSON.stringify(call.body))));
});

test('does not reuse a Codex thumbs-up when the observed PR head changed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pr-shepherd-stale-codex-pass-'));
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
  root: ${path.join(root, 'workspaces')}
review:
  enabled: false
  shepherd_pull_requests: true
codex:
  command: echo unused
---
Prompt.
`, 'utf8');
  const { config } = await loadWorkflowFromFile(workflowPath);
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const feedbackState = `<!-- symphony-pr-feedback-state:v1 -->\n\`\`\`json\n${JSON.stringify({
    version: 1,
    pr_number: 42,
    last_issue_comment_id: null,
    last_review_comment_id: null,
    pending: false,
    feedback_round: 1,
    blocking_feedback_round: 0,
    observed_head_sha: 'old-head',
    priorities: [],
    has_blocking_feedback: false,
    exhausted: false,
    last_codex_approval_reaction_id: null,
    updated_at: '2026-07-17T04:00:00Z',
  })}\n\`\`\``;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.endsWith('/pulls?state=open&per_page=50')) {
      return jsonResponse([{
        number: 42,
        title: 'Fix',
        body: 'Fixes #17',
        state: 'open',
        draft: false,
        labels: [],
        html_url: 'https://github.test/example/app/pull/42',
        head: { ref: 'symphony-17-fix', sha: 'new-head' },
        base: { ref: 'main', sha: 'base' },
        mergeable_state: 'clean',
      }]);
    }
    if (url.endsWith('/issues/42/comments?per_page=50')) return jsonResponse([{ id: 1, body: feedbackState }]);
    if (url.endsWith('/pulls/42/comments?per_page=50')) return jsonResponse([]);
    if (url.endsWith('/issues/42/reactions?per_page=50')) {
      return jsonResponse([{ id: 91, content: '+1', created_at: '2026-07-17T04:30:00Z', user: { login: 'chatgpt-codex-connector[bot]' } }]);
    }
    if (url.endsWith('/pulls/42/commits?per_page=50')) {
      return jsonResponse([{ sha: 'new-head', commit: { committer: { date: '2026-07-17T04:25:00Z' } } }]);
    }
    if (url.endsWith('/issues/comments/1') && method === 'PATCH') return jsonResponse({ id: 1, body: String(body) });
    if (url.endsWith('/issues/42/labels') && method === 'POST') return jsonResponse([]);
    if (url.startsWith('https://api.github.test/repos/example/app/issues/42/labels/') && method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath, repoId: 'app' });
    const shepherd = orchestrator as unknown as {
      reconcilePullRequestFeedback(config: WorkflowConfig, tracker: GithubIssueTrackerClient): Promise<void>;
    };
    await shepherd.reconcilePullRequestFeedback(config, new GithubIssueTrackerClient(config.tracker));
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(!calls.some((call) => /symphony-review-state:v1/.test(JSON.stringify(call.body))));
  const stateUpdate = calls.find((call) => call.url.endsWith('/issues/comments/1') && call.method === 'PATCH');
  assert.match(JSON.stringify(stateUpdate?.body), /observed_head_sha.*new-head/);
  assert.match(JSON.stringify(stateUpdate?.body), /last_codex_approval_reaction_id.*91/);
  assert.ok(calls.some(
    (call) => call.url.endsWith('/issues/42/labels') && /ready-for-human/.test(JSON.stringify(call.body)),
  ));
});
