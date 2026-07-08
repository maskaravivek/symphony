import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startDashboardServer } from './server.js';
import { writeRunState, type RunState } from '../status/runState.js';

function makeRunState(workspacePath: string): RunState {
  return {
    repo_id: null,
    owner: 'mangoappstudio',
    repo: 'mdedit',
    issue_id: 'issue-42',
    issue_number: 42,
    issue_identifier: 'mangoappstudio/mdedit#42',
    issue_url: 'https://github.test/mangoappstudio/mdedit/issues/42',
    issue_title: 'Dashboard test issue',
    issue_state: 'open',
    labels: ['agent-running'],
    workflow_state: 'agent-running',
    workspace_path: workspacePath,
    workspace_strategy: 'durable_issue_workspace',
    attempt: 1,
    session_id: null,
    agent_provider: 'codex',
    agent_provider_group: 'codex',
    agent_provider_kind: 'codex',
    agent_thread_id: 'thread-1234567890',
    agent_mode: 'autonomous',
    agent_log_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    codex_thread_id: 'thread-1234567890',
    codex_mode: 'autonomous',
    pause_reason: null,
    worker_pid: null,
    status: 'running',
    started_at: '2026-07-08T11:00:00.000Z',
    finished_at: null,
    last_exit_code: null,
    last_signal: null,
    last_error: null,
    prompt_path: path.join(workspacePath, '.symphony', 'prompt.md'),
    agent_output_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    codex_jsonl_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    last_message_path: path.join(workspacePath, '.symphony', 'last_message.md'),
    last_seen_comment_id: null,
    status_comment_id: null,
    last_handoff_at: null,
    updated_at: '2026-07-08T12:00:00.000Z',
  };
}

async function writeWorkflow(root: string, workspaceRoot: string): Promise<string> {
  const workflowPath = path.join(root, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  owner: mangoappstudio
  repo: mdedit
  token: test
  terminal_states: [closed]
  required_labels: [ready-for-agent]
  ignored_labels: [blocked, ready-for-human, wontfix]
workspace:
  root: ${workspaceRoot}
codex:
  command: 'true'
---
Prompt
`,
    'utf8',
  );
  return workflowPath;
}

test('serves readonly dashboard HTML and board JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-dashboard-server-'));
  const workspaceRoot = path.join(root, 'workspaces');
  const workspacePath = path.join(workspaceRoot, 'issue-42');
  const workflowPath = await writeWorkflow(root, workspaceRoot);
  await writeRunState(workspacePath, makeRunState(workspacePath));

  const started = await startDashboardServer({
    workflow: workflowPath,
    host: '127.0.0.1',
    port: 0,
    refreshMs: 1000,
  });

  try {
    const htmlResponse = await fetch(started.url);
    assert.equal(htmlResponse.status, 200);
    assert.match(await htmlResponse.text(), /Symphony Dashboard/);

    const boardResponse = await fetch(new URL('/api/board', started.url));
    assert.equal(boardResponse.status, 200);
    const board = (await boardResponse.json()) as { total_cards: number; columns: Array<{ id: string; cards: unknown[] }> };
    assert.equal(board.total_cards, 1);
    assert.equal(board.columns.find((column) => column.id === 'active')?.cards.length, 1);

    const postResponse = await fetch(new URL('/api/board', started.url), { method: 'POST' });
    assert.equal(postResponse.status, 405);
    assert.match(await postResponse.text(), /readonly/);
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});
