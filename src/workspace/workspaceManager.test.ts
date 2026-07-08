import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Issue } from '../domain/issue.js';
import { writeRunState, type RunState } from '../status/runState.js';
import type { WorkspaceConfig } from '../workflow/types.js';
import { WorkspaceManager } from './workspaceManager.js';

function issue(number: number): Issue {
  return {
    id: String(number),
    identifier: `mangoappstudio/mdedit#${number}`,
    number,
    title: `Issue ${number}`,
    description: '',
    priority: null,
    url: `https://github.test/mangoappstudio/mdedit/issues/${number}`,
    state: 'open',
    labels: [],
    assignees: [],
    milestone: null,
    blocked_by: [],
    pull_requests: [],
    workflow_state: null,
    branch_name: `symphony-${number}`,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ready_for_agent_labeled_at: null,
  };
}

function workspaceConfig(root: string): WorkspaceConfig {
  return {
    root,
    clean_on_terminal: false,
    strategy: {
      implementation: 'durable_issue_workspace',
      planning: 'durable_issue_workspace',
      epic: { stacked: 'durable_issue_workspace', independent: 'durable_issue_workspace' },
    },
  };
}

function runningState(workspacePath: string): RunState {
  return {
    repo_id: null,
    owner: 'mangoappstudio',
    repo: 'mdedit',
    issue_id: '1',
    issue_number: 1,
    issue_identifier: 'mangoappstudio/mdedit#1',
    issue_url: 'https://github.test/mangoappstudio/mdedit/issues/1',
    workspace_path: workspacePath,
    workspace_strategy: 'pooled_isolated',
    attempt: 1,
    session_id: 'session-1',
    agent_provider: 'codex',
    agent_provider_group: 'codex',
    agent_provider_kind: 'codex',
    agent_thread_id: null,
    agent_mode: 'autonomous',
    agent_log_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    codex_thread_id: null,
    codex_mode: 'autonomous',
    pause_reason: null,
    worker_pid: null,
    status: 'running',
    started_at: '2026-07-01T00:00:00.000Z',
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
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

test('allocates strategy-specific workspace paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-workspaces-'));
  const manager = new WorkspaceManager(workspaceConfig(root), 2);

  const durable = await manager.ensureWorkspace(issue(12), { strategy: 'durable_issue_workspace' });
  const readonly = await manager.ensureWorkspace(issue(12), { strategy: 'none_or_readonly' });
  const epic = await manager.ensureWorkspace(issue(12), {
    strategy: 'durable_epic_workspace',
    epicRootIssueIdentifier: 'mangoappstudio/mdedit#99',
  });

  assert.equal(durable.workspace_path, path.join(root, 'mangoappstudio_mdedit_12'));
  assert.equal(readonly.workspace_path, path.join(root, 'readonly_mangoappstudio_mdedit_12'));
  assert.equal(epic.workspace_path, path.join(root, 'epic_mangoappstudio_mdedit_99'));
});

test('pooled workspaces skip running slots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-workspace-pool-'));
  const manager = new WorkspaceManager(workspaceConfig(root), 2);
  const firstSlot = path.join(root, '_pool_1');
  await writeRunState(firstSlot, runningState(firstSlot));

  const allocated = await manager.ensureWorkspace(issue(2), { strategy: 'pooled_isolated' });

  assert.equal(allocated.workspace_path, path.join(root, '_pool_2'));
  assert.equal(allocated.strategy, 'pooled_isolated');
  assert.equal(allocated.is_new, true);
});
