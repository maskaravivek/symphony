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

function issuePayload(number: number, title: string, state: string, labels: string[] = []) {
  return {
    id: number,
    node_id: `I_${number}`,
    number,
    title,
    state,
    labels: labels.map((name) => ({ name })),
    html_url: `https://github.test/mangoappstudio/mdedit/issues/${number}`,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true);
}

async function writeWorkflowWithUsageLimit(
  workspaceRoot: string,
  agentCommand: string,
  usageLimitExitCodes: number[],
  usageLimitBackoffMs: number,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-usage-workflow-'));
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
workspace:
  root: ${workspaceRoot}
agent:
  max_concurrent_agents: 2
agents:
  default: codex
  providers:
    codex:
      command: ${agentCommand}
      output_log: .symphony/codex.jsonl
      usage_limit_exit_codes: [${usageLimitExitCodes.join(', ')}]
      usage_limit_backoff_ms: ${usageLimitBackoffMs}
---

Prompt body
`,
    'utf8',
  );
  return workflowPath;
}

function buildMockFetch(
  issueNumbers: number[],
  calls: { url: string; method: string; body: unknown }[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    // Candidate issues
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return jsonResponse(issueNumbers.map((n) => issuePayload(n, `Issue ${n}`, 'open', ['ready-for-agent'])));
    }
    // Open pull requests
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    // Issue by number
    for (const n of issueNumbers) {
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}`) {
        return jsonResponse(issuePayload(n, `Issue ${n}`, 'open', ['agent-running']));
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments?per_page=50`) {
        return jsonResponse([]);
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments` && method === 'POST') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/${500 + n}` && method === 'PATCH') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels` && method === 'POST') {
        return jsonResponse([]);
      }
      if (url.startsWith(`https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels/`) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
}

/**
 * Checks whether a given issue had `agent-running` applied (dispatched) in the recorded calls.
 */
function wasDispatched(calls: { url: string; method: string; body: unknown }[], issueNumber: number): boolean {
  return calls.some(
    (c) =>
      c.url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${issueNumber}/labels` &&
      c.method === 'POST' &&
      JSON.stringify(c.body) === JSON.stringify({ labels: ['agent-running'] }),
  );
}

test('blocks new dispatches to the provider after a usage-limit exit code is seen', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-usage-workspace-'));
  // Issue 10 agent exits with code 5 — a configured usage-limit code.
  // Issue 11 is a second candidate that should NOT be dispatched during backoff.
  const workflowPath = await writeWorkflowWithUsageLimit(workspaceRoot, "bash -c 'exit 5'", [5], 3600000);

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  // Only issue 10 is returned initially; issue 11 will appear on the second tick.
  let tickCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      // First tick returns issue 10 only; second tick returns both 10 and 11
      const issueNums = tickCount === 0 ? [10] : [11];
      return jsonResponse(issueNums.map((n) => issuePayload(n, `Issue ${n}`, 'open', ['ready-for-agent'])));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    for (const n of [10, 11]) {
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}`) {
        return jsonResponse(issuePayload(n, `Issue ${n}`, 'open', ['agent-running']));
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments?per_page=50`) {
        return jsonResponse([]);
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments` && method === 'POST') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/${500 + n}` && method === 'PATCH') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels` && method === 'POST') {
        return jsonResponse([]);
      }
      if (url.startsWith(`https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels/`) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    tickCount = 0;
    await orchestrator.tickOnce();

    // Verify issue 10 was dispatched
    assert.ok(wasDispatched(calls, 10), 'issue 10 should have been dispatched on first tick');

    // Wait for the agent (exit 5) to finish and for the backoff label transition to happen
    // (ready-for-agent is re-applied after the failed run)
    await waitFor(() =>
      calls.some(
        (c) =>
          c.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/10/labels' &&
          c.method === 'POST' &&
          JSON.stringify(c.body) === JSON.stringify({ labels: ['ready-for-agent'] }),
      ),
    );

    // Capture call count before second tick to focus on new calls only
    calls.length = 0;

    tickCount = 1;
    await orchestrator.tickOnce();

    // Issue 11 is new and ready, but the codex provider is in backoff — it must not be dispatched
    assert.equal(wasDispatched(calls, 11), false, 'issue 11 should not be dispatched while provider is in usage limit backoff');

    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('does not block dispatch when exit code is not in usage_limit_exit_codes', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-usage-no-backoff-'));
  // Agent exits with code 1 — NOT a configured usage-limit exit code (only [5] is)
  const workflowPath = await writeWorkflowWithUsageLimit(workspaceRoot, "bash -c 'exit 1'", [5], 3600000);

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  let tickCount = 0;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      const issueNums = tickCount === 0 ? [20] : [21];
      return jsonResponse(issueNums.map((n) => issuePayload(n, `Issue ${n}`, 'open', ['ready-for-agent'])));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    for (const n of [20, 21]) {
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}`) {
        return jsonResponse(issuePayload(n, `Issue ${n}`, 'open', ['agent-running']));
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments?per_page=50`) {
        return jsonResponse([]);
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments` && method === 'POST') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/${500 + n}` && method === 'PATCH') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels` && method === 'POST') {
        return jsonResponse([]);
      }
      if (url.startsWith(`https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels/`) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    tickCount = 0;
    await orchestrator.tickOnce();

    assert.ok(wasDispatched(calls, 20), 'issue 20 should have been dispatched on first tick');

    // Wait for the agent (exit 1) to fail and the retry label to be applied
    await waitFor(() =>
      calls.some(
        (c) =>
          c.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/20/labels' &&
          c.method === 'POST' &&
          JSON.stringify(c.body) === JSON.stringify({ labels: ['ready-for-agent'] }),
      ),
    );

    calls.length = 0;

    tickCount = 1;
    await orchestrator.tickOnce();

    // With no usage limit backoff, issue 21 should be dispatched normally
    assert.ok(wasDispatched(calls, 21), 'issue 21 should be dispatched when exit code is not a usage limit code');

    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
