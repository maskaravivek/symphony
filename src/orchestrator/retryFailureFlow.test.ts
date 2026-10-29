import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from './orchestrator.js';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function issuePayload(labels: string[]) {
  return {
    id: 42,
    node_id: 'I_42',
    number: 42,
    title: 'Workspace setup failure',
    state: 'open',
    labels: labels.map((name) => ({ name })),
    html_url: 'https://github.test/mangoappstudio/mdedit/issues/42',
  };
}

test('setup errors preserve the first implementation attempt and expose automatic recovery', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-retry-failure-workspace-'));
  const workflowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-retry-failure-workflow-'));
  const workflowPath = path.join(workflowDir, 'WORKFLOW.md');
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
  ignored_labels: [blocked, needs-info, ready-for-human, symphony-failed]
workspace:
  root: ${workspaceRoot}
hooks:
  after_create: |
    echo "fixture checkout failed" >&2
    exit 17
agent:
  max_attempts: 1
agents:
  default: codex
  providers:
    codex:
      command: "true"
---

Prompt body
`,
    'utf8',
  );

  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return jsonResponse([issuePayload(['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') return jsonResponse([]);
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments?per_page=50') return jsonResponse([]);
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments' && method === 'POST') {
      return jsonResponse({ id: 420, body: String(body), html_url: 'https://github.test/comment/420' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels' && method === 'POST') return jsonResponse([]);
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });
  try {
    await orchestrator.tickOnce();
    await orchestrator.waitForPreparations();
  } finally {
    await orchestrator.shutdown('test');
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(workflowDir, { recursive: true, force: true });
  }

  const labelWrites = calls
    .filter((call) => call.url.endsWith('/issues/42/labels') && call.method === 'POST')
    .flatMap((call) => ((call.body as { labels?: string[] } | null)?.labels ?? []));
  const commentBodies = calls
    .filter((call) => call.url.endsWith('/issues/42/comments') && call.method === 'POST')
    .map((call) => String((call.body as { body?: string } | null)?.body ?? ''));

  assert.equal(labelWrites.includes('symphony-failed'), false);
  assert.equal(labelWrites.includes('needs-info'), false);
  assert.match(commentBodies.join('\n'), /fixture checkout failed/);
  assert.match(commentBodies.join('\n'), /retry automatically/);
});
