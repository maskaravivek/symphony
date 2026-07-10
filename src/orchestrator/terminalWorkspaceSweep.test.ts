import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readRunState, writeRunState, type RunState } from '../status/runState.js';
import { Orchestrator } from './orchestrator.js';
import { acquireWorkflowLock } from './workflowLock.js';

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

async function writeWorkflow(workspaceRoot: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-sweep-workflow-'));
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
  clean_on_terminal: true
codex:
  command: echo should-not-run
  resume_command: echo should-not-run
  handoff_command: echo should-not-run
---

Prompt body
`,
    'utf8',
  );
  return workflowPath;
}

function runState(workspacePath: string, overrides: Partial<RunState> = {}): RunState {
  return {
    repo_id: null,
    owner: 'mangoappstudio',
    repo: 'mdedit',
    issue_id: 'I_42',
    issue_number: 42,
    issue_identifier: 'mangoappstudio/mdedit#42',
    issue_url: 'https://github.test/mangoappstudio/mdedit/issues/42',
    labels: ['ready-for-human'],
    workflow_state: 'ready-for-human',
    workspace_path: workspacePath,
    attempt: 1,
    session_id: 'session-42',
    agent_provider: 'codex',
    agent_thread_id: 'thread-42',
    agent_mode: 'autonomous',
    agent_log_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    codex_thread_id: 'thread-42',
    codex_mode: 'autonomous',
    pause_reason: null,
    worker_pid: null,
    status: 'completed',
    started_at: '2026-07-01T00:00:00.000Z',
    finished_at: '2026-07-01T00:01:00.000Z',
    last_exit_code: 0,
    last_signal: null,
    last_error: null,
    prompt_path: path.join(workspacePath, '.symphony', 'prompt.md'),
    agent_output_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    codex_jsonl_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    last_message_path: path.join(workspacePath, '.symphony', 'last_message.md'),
    last_seen_comment_id: 100,
    status_comment_id: 200,
    last_handoff_at: null,
    updated_at: '2026-07-01T00:01:00.000Z',
    ...overrides,
  };
}

async function writeWorkspace(workspaceRoot: string, name = 'mangoappstudio_mdedit_42', overrides: Partial<RunState> = {}): Promise<string> {
  const workspacePath = path.join(workspaceRoot, name);
  await fs.mkdir(path.join(workspacePath, '.symphony'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'README.md'), 'checkout contents\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, '.symphony', 'last_message.md'), 'previous result\n', 'utf8');
  await writeRunState(workspacePath, runState(workspacePath, overrides));
  return workspacePath;
}

function installFetchMock(issueState: string, calls: { url: string; method: string }[]): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });

    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42') {
      return jsonResponse(issuePayload(42, 'Swept issue', issueState));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42') {
      return jsonResponse(issuePayload(42, 'Pooled live issue', 'open', ['ready-for-agent']));
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('sweeps completed workspaces for closed issues when clean_on_terminal is enabled', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-sweep-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  const workspacePath = await writeWorkspace(workspaceRoot);
  const calls: { url: string; method: string }[] = [];
  const restoreFetch = installFetchMock('closed', calls);

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    restoreFetch();
  }

  await assert.rejects(fs.access(workspacePath));
  const entries = await fs.readdir(workspaceRoot);
  assert.deepEqual(entries.sort(), ['.symphony', '_archives']);
  const archives = await fs.readdir(path.join(workspaceRoot, '_archives'));
  assert.equal(archives.length, 1);
  assert.ok(calls.some((call) => call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42'));
});

test('keeps live running workspaces during terminal sweeps', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-live-sweep-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  const workspacePath = await writeWorkspace(workspaceRoot, 'mangoappstudio_mdedit_42', {
    status: 'running',
    finished_at: null,
    last_exit_code: null,
    worker_pid: process.pid,
  });
  const calls: { url: string; method: string }[] = [];
  const restoreFetch = installFetchMock('closed', calls);

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    restoreFetch();
  }

  await assert.doesNotReject(fs.access(workspacePath));
  assert.equal(calls.some((call) => call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42'), false);
});

test('orphan reconciliation recovers live pooled workspaces', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-pooled-orphan-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  const workspacePath = await writeWorkspace(workspaceRoot, '_pool_1', {
    status: 'running',
    labels: ['agent-running'],
    workflow_state: 'agent-running',
    finished_at: null,
    last_exit_code: null,
    worker_pid: process.pid,
    workspace_strategy: 'pooled_isolated',
  });
  const calls: { url: string; method: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });

    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&per_page=50') {
      return jsonResponse([issuePayload(42, 'Pooled live issue', 'open', ['agent-running'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels' && method === 'POST') {
      return jsonResponse([{ name: 'ready-for-agent' }]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels/agent-running' && method === 'DELETE') {
      return new Response(null, { status: 204 });
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

  await assert.doesNotReject(fs.access(workspacePath));
  const state = await readRunState(workspacePath);
  assert.equal(state?.status, 'cancelled');
  assert.equal(state?.workflow_state, 'ready-for-agent');
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.includes('/labels/agent-running')), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.url.endsWith('/labels')), true);
});

test('live orphaned workers are recovered before dispatch capacity is checked', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-orphan-capacity-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  await writeWorkspace(workspaceRoot, 'mangoappstudio_mdedit_42', {
    status: 'running',
    labels: ['agent-running'],
    workflow_state: 'agent-running',
    finished_at: null,
    last_exit_code: null,
    worker_pid: process.pid,
  });
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&per_page=50') {
      return jsonResponse([issuePayload(42, 'Live orphan', 'open', ['agent-running'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([issuePayload(43, 'Queued issue', 'open', ['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42') {
      return jsonResponse(issuePayload(42, 'Live orphan', 'open', ['ready-for-agent']));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels' && method === 'POST') {
      return jsonResponse([{ name: 'ready-for-agent' }]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels/agent-running' && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/labels' && method === 'POST') {
      return jsonResponse([{ name: 'agent-running' }]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/labels/ready-for-agent' && method === 'DELETE') {
      return new Response(null, { status: 204 });
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

  assert.equal(
    calls.some(
      (call) =>
        call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/comments?per_page=50' &&
        call.method === 'GET',
    ),
    true,
  );
});

test('workflow lock prevents a duplicate orchestrator tick', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-duplicate-lock-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  const lock = await acquireWorkflowLock({
    workspaceRoot,
    repoId: null,
    owner: 'mangoappstudio',
    repo: 'mdedit',
    workflowPath,
  });
  assert.equal(lock.acquired, true);

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('duplicate orchestrator should not fetch');
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    if (lock.acquired) await lock.lock.release();
  }

  assert.equal(fetchCalls, 0);
});
