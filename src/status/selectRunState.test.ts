import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunState } from './runState.js';
import { selectRunState } from './selectRunState.js';

function makeState(repoId: string, issueNumber: number): RunState {
  return {
    repo_id: repoId,
    owner: 'mangoappstudio',
    repo: repoId,
    issue_id: `${repoId}-${issueNumber}`,
    issue_number: issueNumber,
    issue_identifier: `mangoappstudio/${repoId}#${issueNumber}`,
    issue_url: null,
    labels: ['agent-running'],
    workflow_state: 'agent-running',
    workspace_path: `/tmp/${repoId}-${issueNumber}`,
    attempt: 1,
    session_id: null,
    codex_thread_id: null,
    codex_mode: 'autonomous',
    pause_reason: null,
    worker_pid: null,
    status: 'running',
    started_at: null,
    finished_at: null,
    last_exit_code: null,
    last_signal: null,
    last_error: null,
    prompt_path: null,
    codex_jsonl_path: null,
    last_message_path: null,
    last_seen_comment_id: null,
    status_comment_id: null,
    last_handoff_at: null,
    updated_at: '2026-05-18T00:00:00.000Z',
  };
}

test('selects repo-qualified issue refs', () => {
  const states = [makeState('mdedit', 264), makeState('myaarti', 264)];
  const selection = selectRunState(states, 'myaarti#264');

  assert.equal(selection.ambiguous, false);
  assert.equal(selection.state?.repo_id, 'myaarti');
});

test('marks bare issue numbers ambiguous across repos', () => {
  const states = [makeState('mdedit', 264), makeState('myaarti', 264)];
  const selection = selectRunState(states, '264');

  assert.equal(selection.ambiguous, true);
  assert.equal(selection.state, null);
  assert.equal(selection.matches.length, 2);
});
