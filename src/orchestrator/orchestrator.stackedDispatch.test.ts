import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeRunState, type RunState } from '../status/runState.js';
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
    repository_url: 'https://api.github.test/repos/mangoappstudio/mdedit',
  };
}

async function writeWorkflow(workspaceRoot: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-stacked-dispatch-workflow-'));
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
  epics:
    enabled: true
    relationship_source: native_subissues
    auto_label_children: true
    parent_mode: coordinator_only
    execution_mode: independent
    max_depth: 8
workspace:
  root: ${workspaceRoot}
hooks:
  before_run: |
    mkdir -p .symphony
    printf "%s" "$SYMPHONY_STACK_BASE_BRANCH" > .symphony/stack-base-branch.txt
agents:
  default: codex
  providers:
    codex:
      command: bash -lc 'printf "fresh:%s:%s" "$SYMPHONY_STACK_BASE_BRANCH" "$SYMPHONY_AGENT_THREAD_ID" > .symphony/last_message.md'
      resume_command: bash -lc 'printf "resume:%s:%s" "$SYMPHONY_STACK_BASE_BRANCH" "$SYMPHONY_AGENT_THREAD_ID" > .symphony/last_message.md'
      handoff_command: bash -lc 'printf "handoff" > .symphony/last_message.md'
---

Issue {{ issue.identifier }}
`,
    'utf8',
  );
  return workflowPath;
}

async function waitFor(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await predicate(), true);
}

async function writePredecessorState(workspaceRoot: string): Promise<void> {
  const workspacePath = path.join(workspaceRoot, 'mangoappstudio_mdedit_43');
  await fs.mkdir(path.join(workspacePath, '.symphony'), { recursive: true });
  const lastMessagePath = path.join(workspacePath, '.symphony', 'last_message.md');
  await fs.writeFile(lastMessagePath, 'Previous stacked leaf summary.\n', 'utf8');
  const state: RunState = {
    repo_id: null,
    owner: 'mangoappstudio',
    repo: 'mdedit',
    issue_id: '43',
    issue_number: 43,
    issue_identifier: 'mangoappstudio/mdedit#43',
    issue_url: 'https://github.test/mangoappstudio/mdedit/issues/43',
    labels: ['ready-for-human'],
    workflow_state: 'ready-for-human',
    workspace_path: workspacePath,
    attempt: 1,
    session_id: 'session-43',
    agent_provider: 'codex',
    agent_provider_group: 'codex',
    agent_provider_kind: 'codex',
    agent_thread_id: 'thread-43',
    agent_mode: 'autonomous',
    agent_log_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    codex_thread_id: 'thread-43',
    codex_mode: 'autonomous',
    pause_reason: null,
    worker_pid: null,
    status: 'completed',
    started_at: '2026-07-05T00:00:00.000Z',
    finished_at: '2026-07-05T00:01:00.000Z',
    last_exit_code: 0,
    last_signal: null,
    last_error: null,
    prompt_path: path.join(workspacePath, '.symphony', 'prompt.md'),
    agent_output_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    codex_jsonl_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    last_message_path: lastMessagePath,
    last_seen_comment_id: 100,
    status_comment_id: 200,
    last_handoff_at: null,
    updated_at: '2026-07-05T00:01:00.000Z',
  };
  await writeRunState(workspacePath, state);
}

test('stacked epic dispatch reuses predecessor codex thread and exports stack base branch to hooks', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-stacked-dispatch-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  await writePredecessorState(workspaceRoot);
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
      return jsonResponse([issuePayload(44, 'Second leaf', 'open', ['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/parent') {
      return jsonResponse(issuePayload(42, 'Epic parent', 'open', ['ready-for-agent', 'epic:stacked']));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/sub_issues?per_page=50') {
      return jsonResponse([
        issuePayload(43, 'First leaf', 'open', ['ready-for-human']),
        issuePayload(44, 'Second leaf', 'open', ['ready-for-agent']),
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44') {
      return jsonResponse(issuePayload(44, 'Second leaf', 'open', ['agent-running']));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/44/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/comments?per_page=50' && method === 'GET') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/comments' && method === 'POST') {
      return jsonResponse({ id: 700, body: String(body), html_url: 'https://github.test/comment/700' });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/700' && method === 'PATCH') {
      return jsonResponse({ id: 700, body: String(body), html_url: 'https://github.test/comment/700' });
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    const workspacePath = path.join(workspaceRoot, 'mangoappstudio_mdedit_44');
    await waitFor(async () => {
      try {
        const lastMessage = await fs.readFile(path.join(workspacePath, '.symphony', 'last_message.md'), 'utf8');
        return lastMessage.startsWith('resume:symphony-43-first-leaf:thread-43');
      } catch {
        return false;
      }
    });
    await waitFor(() =>
      calls.some(
        (call) =>
          call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/labels' &&
          call.method === 'POST' &&
          JSON.stringify(call.body) === JSON.stringify({ labels: ['ready-for-human'] }),
      ),
    );
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const workspacePath = path.join(workspaceRoot, 'mangoappstudio_mdedit_44');
  const prompt = await fs.readFile(path.join(workspacePath, '.symphony', 'prompt.md'), 'utf8');
  const lastMessage = await fs.readFile(path.join(workspacePath, '.symphony', 'last_message.md'), 'utf8');
  const stackBaseBranch = await fs.readFile(path.join(workspacePath, '.symphony', 'stack-base-branch.txt'), 'utf8');

  assert.match(prompt, /## Stacked Epic Context/);
  assert.match(prompt, /Previous stacked leaf summary\./);
  assert.equal(lastMessage, 'resume:symphony-43-first-leaf:thread-43');
  assert.equal(stackBaseBranch, 'symphony-43-first-leaf');
});

test('first stacked epic leaf uses main as its base branch', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-first-stacked-dispatch-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
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
      return jsonResponse([issuePayload(43, 'First leaf', 'open', ['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/parent') {
      return jsonResponse(issuePayload(42, 'Epic parent', 'open', ['ready-for-agent', 'epic:stacked']));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/sub_issues?per_page=50') {
      return jsonResponse([
        issuePayload(43, 'First leaf', 'open', ['ready-for-agent']),
        issuePayload(44, 'Second leaf', 'open', []),
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/comments?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43') {
      return jsonResponse(issuePayload(43, 'First leaf', 'open', ['agent-running']));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues/43/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/comments' && method === 'POST') {
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
    const workspacePath = path.join(workspaceRoot, 'mangoappstudio_mdedit_43');
    await waitFor(async () => {
      try {
        return (await fs.readFile(path.join(workspacePath, '.symphony', 'last_message.md'), 'utf8')).startsWith('fresh:');
      } catch {
        return false;
      }
    });
    await waitFor(() =>
      calls.some(
        (call) =>
          call.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/labels' &&
          call.method === 'POST' &&
          JSON.stringify(call.body) === JSON.stringify({ labels: ['ready-for-human'] }),
      ),
    );
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const workspacePath = path.join(workspaceRoot, 'mangoappstudio_mdedit_43');
  const prompt = await fs.readFile(path.join(workspacePath, '.symphony', 'prompt.md'), 'utf8');
  const stackBaseBranch = await fs.readFile(path.join(workspacePath, '.symphony', 'stack-base-branch.txt'), 'utf8');

  assert.match(prompt, /Open this issue's PR against `main`/);
  assert.equal(stackBaseBranch, 'main');
});
