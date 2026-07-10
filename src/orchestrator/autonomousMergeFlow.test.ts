import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from './orchestrator.js';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('reconciles a reviewed PR through policy gates and expected-SHA merge', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-merge-flow-'));
  const workflowPath = path.join(root, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  owner: example
  repo: app
  token: token
  api_base_url: https://api.github.test
  required_labels: [ready-for-agent]
  branch_prefix: symphony
workspace:
  root: ${path.join(root, 'workspaces')}
merge:
  enabled: true
  method: squash
codex:
  command: echo unused
---

Issue prompt.
`,
    'utf8',
  );

  const pr = {
    number: 42,
    title: 'Safe change',
    body: 'Fixes #17',
    state: 'open',
    draft: false,
    labels: [{ name: 'symphony-review:passed' }],
    html_url: 'https://github.test/example/app/pull/42',
    head: { ref: 'symphony-17-safe-change', sha: 'head-sha' },
    base: { ref: 'main', sha: 'base-sha' },
    mergeable_state: 'clean',
  };
  const reviewState = `<!-- symphony-review-state:v1 -->
\`\`\`json
${JSON.stringify({
  version: 1,
  pr_number: 42,
  issue_number: 17,
  head_ref: 'symphony-17-safe-change',
  head_sha: 'head-sha',
  base_ref: 'main',
  base_sha: 'base-sha',
  verdict: 'pass',
  auto_fix_iterations: 0,
  reviewed_at: '2026-07-10T00:00:00Z',
  reason: 'pass',
  receipts: [{
    receipt_id: 'review-1',
    verifier: 'post-run-review',
    verdict: 'pass',
    head_sha: 'head-sha',
    base_sha: 'base-sha',
    evidence: ['review passed'],
    verified_at: '2026-07-10T00:00:00Z',
  }],
})}
\`\`\``;
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.endsWith('/pulls?state=open&per_page=50')) return jsonResponse([pr]);
    if (url.endsWith('/pulls/42') && method === 'GET') return jsonResponse(pr);
    if (url.endsWith('/issues/42/comments?per_page=50')) return jsonResponse([{ id: 1, body: reviewState }]);
    if (url.endsWith('/pulls/42/files?per_page=50')) return jsonResponse([{ filename: 'src/safe.ts' }]);
    if (url.endsWith('/commits/head-sha/check-runs?per_page=100')) {
      return jsonResponse({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] });
    }
    if (url.endsWith('/commits/head-sha/status')) return jsonResponse({ statuses: [] });
    if (url.endsWith('/pulls/42/merge') && method === 'PUT') return jsonResponse({ merged: true, sha: 'merge-sha', message: 'merged' });
    if (url.includes('/issues?')) return jsonResponse([]);
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath, repoId: 'app' });
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(calls.some((call) => call.url.endsWith('/pulls/42/merge') && call.method === 'PUT'));
  assert.deepEqual(calls.find((call) => call.url.endsWith('/pulls/42/merge'))?.body, {
    sha: 'head-sha',
    merge_method: 'squash',
  });
});
