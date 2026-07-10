import assert from 'node:assert/strict';
import test from 'node:test';

import type { Issue } from '../domain/issue.js';
import type { EpicState } from '../status/epicState.js';
import type { WorkflowConfig } from '../workflow/types.js';
import { epicStatusMarker, formatEpicStatusComment } from './epicStatusComment.js';

function issue(): Issue {
  return {
    id: 'I_parent',
    identifier: 'mangoappstudio/mdedit#42',
    number: 42,
    title: 'Epic parent',
    description: null,
    priority: null,
    state: 'open',
    workflow_state: 'ready-for-agent',
    branch_name: 'symphony/42-epic-parent',
    url: 'https://github.test/mangoappstudio/mdedit/issues/42',
    labels: ['ready-for-agent'],
    assignees: [],
    milestone: null,
    blocked_by: [],
    pull_requests: [],
    created_at: null,
    updated_at: null,
    ready_for_agent_labeled_at: null,
  };
}

function config(): WorkflowConfig {
  return {
    tracker: {
      kind: 'github',
      owner: 'mangoappstudio',
      repo: 'mdedit',
      token: 'token',
      api_base_url: 'https://api.github.test',
      graphql_url: 'https://api.github.test/graphql',
      candidate_order: 'priority_then_created_at',
      active_states: ['open'],
      terminal_states: ['closed'],
      required_labels: ['ready-for-agent'],
      any_required_labels: null,
      ignored_labels: ['blocked'],
      priority_labels: null,
      branch_prefix: 'symphony',
      include_pull_requests: false,
      epics: {
        enabled: true,
        relationship_source: 'native_subissues',
        auto_label_children: true,
        parent_mode: 'coordinator_only',
        execution_mode: 'independent',
        max_depth: 8,
      },
      page_size: 50,
      request_timeout_ms: 5000,
    },
    polling: { interval_ms: 30000 },
    workspace: {
      root: '/tmp/symphony-test',
      clean_on_terminal: false,
      strategy: {
        implementation: 'durable_issue_workspace',
        planning: 'durable_issue_workspace',
        epic: { stacked: 'durable_issue_workspace', independent: 'durable_issue_workspace' },
      },
    },
    hooks: { after_create: null, before_run: null, after_run: null, timeout_ms: 120000 },
    agent: { max_concurrent_agents: 1, max_retry_backoff_ms: 300000, max_attempts: null, max_concurrent_agents_by_state: null },
    review: { auto_fix_review_comments: false, number_of_auto_fix_iterations: 1 },
    merge: { enabled: false, dry_run: false, method: 'squash', default_risk: 'standard', rules: [] },
    loops: [],
    codex: { command: 'codex exec -', resume_command: 'codex exec resume thread -', handoff_command: 'codex exec -', turn_timeout_ms: 3600000 },
    agents: {
      default: 'codex',
      providers: {
        codex: {
          id: 'codex',
          provider_group: 'codex',
          provider_kind: 'codex',
          command: 'codex exec -',
          resume_command: 'codex exec resume thread -',
          handoff_command: 'codex exec -',
          turn_timeout_ms: 3600000,
          output_log: '.symphony/codex.jsonl',
          max_concurrent: null,
          extract_codex_thread_id: true,
          usage_limit_exit_codes: null,
          usage_limit_backoff_ms: 0,
          usage_limit_check_command: null,
        },
      },
      routes: [{ provider: 'codex', any_labels: [], all_labels: [], none_labels: [], default: true }],
    },
  };
}

test('formats epic status comment with child queue details', () => {
  const parent = issue();
  const state: EpicState = {
    repo_id: null,
    owner: 'mangoappstudio',
    repo: 'mdedit',
    issue_id: parent.id,
    issue_number: parent.number,
    issue_identifier: parent.identifier,
    issue_url: parent.url,
    title: parent.title,
    labels: parent.labels,
    status: 'coordinating',
    open_children: 1,
    terminal_children: 1,
    total_children: 2,
    status_comment_id: null,
    updated_at: '2026-06-18T00:00:00.000Z',
    children: [
      {
        issue_id: 'I_child_1',
        issue_number: 43,
        issue_identifier: 'mangoappstudio/mdedit#43',
        issue_url: null,
        title: 'Queued child',
        state: 'open',
        labels: ['ready-for-agent'],
        depth: 1,
        leaf: true,
        queued: true,
        skipped_reason: null,
      },
      {
        issue_id: 'I_child_2',
        issue_number: 44,
        issue_identifier: 'mangoappstudio/mdedit#44',
        issue_url: null,
        title: 'Done child',
        state: 'closed',
        labels: [],
        depth: 1,
        leaf: true,
        queued: false,
        skipped_reason: 'terminal_state',
      },
    ],
  };

  const body = formatEpicStatusComment({ issue: parent, config: config(), repoId: null, state, message: 'Epic coordination is active.' });
  assert.ok(body.includes(epicStatusMarker(parent)));
  assert.ok(body.includes('Children: 1/2 terminal, 1 open'));
  assert.ok(body.includes('| #43 | Queued child | open | leaf | yes | ready-for-agent |'));
  assert.ok(body.includes('| #44 | Done child | closed | leaf | no (terminal_state) | none |'));
});
