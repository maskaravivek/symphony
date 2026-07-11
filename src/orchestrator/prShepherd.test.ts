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

test('queues a reviewed Symphony PR when a new inline review comment arrives', async () => {
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
  shepherd_pull_requests: true
codex:
  command: echo unused
---
Prompt.
`, 'utf8');
  const { config } = await loadWorkflowFromFile(workflowPath);
  const state = {
    version: 1,
    pr_number: 42,
    issue_number: 17,
    head_ref: 'symphony-17-fix',
    head_sha: 'head',
    base_ref: 'main',
    base_sha: 'base',
    verdict: 'pass',
    auto_fix_iterations: 0,
    reviewed_at: '2026-07-10T00:00:00Z',
    reason: 'passed',
    receipts: [],
    last_review_comment_id: 10,
  };
  const stateComment = `<!-- symphony-review-state:v1 -->\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``;
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
    if (url.endsWith('/issues/42/comments?per_page=50')) return jsonResponse([{ id: 1, body: stateComment }]);
    if (url.endsWith('/pulls/42/comments?per_page=50')) return jsonResponse([{ id: 11, body: 'Please cover the empty state.' }]);
    if (url.endsWith('/issues/comments/1') && method === 'PATCH') return jsonResponse({ id: 1 });
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
  const stateUpdate = calls.find((call) => call.url.endsWith('/issues/comments/1') && call.method === 'PATCH');
  assert.match(JSON.stringify(stateUpdate?.body), /last_review_comment_id.*11/);
});
