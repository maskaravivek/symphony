import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildBoardState, classifyRunState, loadBoardState } from './boardState.js';
import { writeEpicStates, type EpicState } from './epicState.js';
import { writeRunState, type RunState } from './runState.js';
import type { WorkflowConfig } from '../workflow/types.js';

const NOW = new Date('2026-07-08T12:00:00.000Z');

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    repo_id: overrides.repo_id !== undefined ? overrides.repo_id : 'mdedit',
    owner: overrides.owner !== undefined ? overrides.owner : 'mangoappstudio',
    repo: overrides.repo !== undefined ? overrides.repo : 'mdedit',
    issue_id: overrides.issue_id ?? 'issue-42',
    issue_number: overrides.issue_number ?? 42,
    issue_identifier: overrides.issue_identifier ?? 'mangoappstudio/mdedit#42',
    issue_url: overrides.issue_url ?? 'https://github.test/mangoappstudio/mdedit/issues/42',
    issue_title: overrides.issue_title ?? 'Default issue',
    issue_state: overrides.issue_state ?? 'open',
    labels: overrides.labels ?? [],
    workflow_state: overrides.workflow_state ?? null,
    workspace_path: overrides.workspace_path ?? '/tmp/workspace',
    workspace_strategy: overrides.workspace_strategy ?? 'durable_issue_workspace',
    attempt: overrides.attempt ?? 1,
    session_id: overrides.session_id ?? null,
    agent_provider: overrides.agent_provider ?? 'codex',
    agent_provider_group: overrides.agent_provider_group ?? 'codex',
    agent_provider_kind: overrides.agent_provider_kind ?? 'codex',
    agent_thread_id: overrides.agent_thread_id ?? null,
    agent_mode: overrides.agent_mode ?? 'autonomous',
    agent_log_path: overrides.agent_log_path ?? '/tmp/workspace/.symphony/codex.jsonl',
    codex_thread_id: overrides.codex_thread_id ?? null,
    codex_mode: overrides.codex_mode ?? 'autonomous',
    pause_reason: overrides.pause_reason ?? null,
    worker_pid: overrides.worker_pid ?? null,
    status: overrides.status ?? 'completed',
    started_at: overrides.started_at ?? '2026-07-08T11:00:00.000Z',
    finished_at: overrides.finished_at ?? null,
    last_exit_code: overrides.last_exit_code ?? null,
    last_signal: overrides.last_signal ?? null,
    last_error: overrides.last_error ?? null,
    prompt_path: overrides.prompt_path ?? '/tmp/workspace/.symphony/prompt.md',
    agent_output_path: overrides.agent_output_path ?? '/tmp/workspace/.symphony/codex.jsonl',
    codex_jsonl_path: overrides.codex_jsonl_path ?? '/tmp/workspace/.symphony/codex.jsonl',
    last_message_path: overrides.last_message_path ?? '/tmp/workspace/.symphony/last_message.md',
    last_seen_comment_id: overrides.last_seen_comment_id ?? null,
    last_seen_pr_review_comment_id: overrides.last_seen_pr_review_comment_id ?? null,
    status_comment_id: overrides.status_comment_id ?? null,
    last_handoff_at: overrides.last_handoff_at ?? null,
    updated_at: overrides.updated_at ?? NOW.toISOString(),
  };
}

function makeWorkflowConfig(workspaceRoot: string, repo = 'mdedit'): WorkflowConfig {
  return {
    tracker: {
      kind: 'github',
      owner: 'mangoappstudio',
      repo,
      token: 'test',
      api_base_url: 'https://api.github.test',
      graphql_url: 'https://api.github.test/graphql',
      candidate_order: 'priority_then_created_at',
      active_states: ['open'],
      terminal_states: ['closed'],
      required_labels: ['ready-for-agent'],
      any_required_labels: null,
      ignored_labels: ['blocked', 'ready-for-human', 'wontfix'],
      priority_labels: null,
      branch_prefix: 'symphony',
      include_pull_requests: false,
      epics: {
        enabled: false,
        relationship_source: 'native_subissues',
        auto_label_children: true,
        parent_mode: 'coordinator_only',
        execution_mode: 'independent',
        max_depth: 8,
      },
      page_size: 50,
      request_timeout_ms: 30000,
    },
    polling: { interval_ms: 30000 },
    workspace: {
      root: workspaceRoot,
      clean_on_terminal: false,
      strategy: {
        implementation: 'durable_issue_workspace',
        planning: 'durable_issue_workspace',
        epic: {
          stacked: 'durable_issue_workspace',
          independent: 'durable_issue_workspace',
        },
      },
    },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      timeout_ms: 120000,
    },
    agent: {
      max_concurrent_agents: 1,
      max_retry_backoff_ms: 300000,
      max_attempts: 2,
      max_concurrent_agents_by_state: null,
    },
    review: {
      auto_fix_review_comments: false,
      number_of_auto_fix_iterations: 1,
      shepherd_pull_requests: false,
      lenses: ['staff-engineer'],
    },
    merge: { enabled: false, dry_run: false, method: 'squash', default_risk: 'standard', rules: [] },
    loops: [],
    codex: {
      command: 'true',
      resume_command: 'true',
      handoff_command: 'true',
      turn_timeout_ms: 3600000,
    },
    agents: {
      default: 'codex',
      providers: {
        codex: {
          id: 'codex',
          provider_group: 'codex',
          provider_kind: 'codex',
          command: 'true',
          resume_command: 'true',
          handoff_command: 'true',
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

function makeEpic(overrides: Partial<EpicState> = {}): EpicState {
  return {
    repo_id: 'mdedit',
    owner: 'mangoappstudio',
    repo: 'mdedit',
    issue_id: 'epic-1',
    issue_number: 100,
    issue_identifier: 'mangoappstudio/mdedit#100',
    issue_url: 'https://github.test/mangoappstudio/mdedit/issues/100',
    title: 'Epic parent',
    labels: ['ready-for-agent'],
    status: overrides.status ?? 'coordinating',
    open_children: overrides.open_children ?? 1,
    terminal_children: overrides.terminal_children ?? 2,
    total_children: overrides.total_children ?? 3,
    children: overrides.children ?? [],
    status_comment_id: null,
    updated_at: overrides.updated_at ?? NOW.toISOString(),
    ...overrides,
  };
}

async function writeWorkflow(dir: string, workspaceRoot: string, repo: string): Promise<string> {
  const workflowPath = path.join(dir, `${repo}.WORKFLOW.md`);
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  owner: mangoappstudio
  repo: ${repo}
  token: test
  api_base_url: https://api.github.test
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

test('classifies local run states into dashboard columns by priority', () => {
  const terminalStates = ['closed'];
  const cases: Array<[string, RunState, string]> = [
    ['active', makeRunState({ status: 'running', labels: ['blocked'] }), 'active'],
    ['needs info', makeRunState({ pause_reason: 'needs-info', labels: ['blocked'] }), 'needs-info'],
    ['blocked', makeRunState({ labels: ['blocked', 'symphony-review:blocking'] }), 'blocked'],
    ['review blocked', makeRunState({ labels: ['symphony-review:blocking', 'symphony-review:auto-fix-2'] }), 'review-blocked'],
    ['ready review label', makeRunState({ labels: ['symphony-review:passed', 'ready-for-human'] }), 'ready-for-review'],
    ['ready review mode', makeRunState({ agent_mode: 'pr-review', workflow_state: 'ready-for-human' }), 'ready-for-review'],
    ['waiting human', makeRunState({ labels: ['ready-for-human'] }), 'waiting-human'],
    ['queued', makeRunState({ labels: ['ready-for-agent'] }), 'queued'],
    ['closed', makeRunState({ issue_state: 'closed', labels: ['symphony-review:passed', 'ready-for-human'], status: 'cancelled' }), 'closed'],
    ['failed', makeRunState({ status: 'failed' }), 'failed-cancelled'],
    ['cancelled', makeRunState({ status: 'cancelled' }), 'failed-cancelled'],
  ];

  for (const [name, state, expected] of cases) {
    assert.equal(classifyRunState(state, terminalStates), expected, name);
  }
});

test('collapses issue and pull request run states into one task card', () => {
  const board = buildBoardState({
    source: { kind: 'workflow', path: '/tmp/WORKFLOW.md' },
    refreshMs: 5000,
    now: NOW,
    repos: [
      {
        repoId: 'mdedit',
        workflowPath: '/tmp/WORKFLOW.md',
        config: makeWorkflowConfig('/tmp/workspace'),
        runs: [
          makeRunState({ issue_number: 42, issue_identifier: 'mangoappstudio/mdedit#42', labels: ['ready-for-human'] }),
          makeRunState({
            issue_id: 'pr-77',
            issue_number: 77,
            issue_identifier: 'mangoappstudio/mdedit#77',
            issue_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
            labels: ['symphony-review:passed', 'ready-for-human'],
            agent_mode: 'pr-review',
          }),
        ],
        epics: [],
        pullRequests: [
          {
            number: 77,
            title: 'Implementation PR',
            body: 'Fixes #42',
            state: 'open',
            labels: ['ready-for-human'],
            is_draft: false,
            url: 'https://github.test/mangoappstudio/mdedit/pull/77',
            head_ref: 'symphony-42-work',
            head_sha: 'abc123',
            base_ref: 'main',
            base_sha: 'base123',
            merge_state_status: 'clean',
          },
        ],
      },
    ],
  });

  assert.equal(board.total_cards, 1);
  const card = board.columns.flatMap((column) => column.cards)[0];
  assert.equal(card?.sources_count, 2);
  assert.equal(card?.pr_number, 77);
  assert.equal(card?.column, 'ready-for-review');
});

test('builds epic cards without a separate epics column', () => {
  const board = buildBoardState({
    source: { kind: 'workflow', path: '/tmp/WORKFLOW.md' },
    refreshMs: 5000,
    now: NOW,
    repos: [
      {
        repoId: 'mdedit',
        workflowPath: '/tmp/WORKFLOW.md',
        config: makeWorkflowConfig('/tmp/workspace'),
        runs: [],
        epics: [makeEpic(), makeEpic({ issue_id: 'epic-2', issue_number: 101, issue_identifier: 'mangoappstudio/mdedit#101', status: 'completed' })],
        pullRequests: [],
      },
    ],
  });

  assert.equal(board.columns.some((column) => (column.id as string) === 'epics'), false);
  assert.equal(board.columns.find((column) => column.id === 'active')?.cards[0]?.epic_progress, '2/3');
  assert.equal(board.columns.find((column) => column.id === 'closed')?.cards[0]?.status, 'epic:completed');
});

test('does not flag terminal history as stale', () => {
  const oldTimestamp = '2026-07-01T00:00:00.000Z';
  const board = buildBoardState({
    source: { kind: 'workflow', path: '/tmp/WORKFLOW.md' },
    refreshMs: 5000,
    now: NOW,
    repos: [
      {
        repoId: 'mdedit',
        workflowPath: '/tmp/WORKFLOW.md',
        config: makeWorkflowConfig('/tmp/workspace'),
        runs: [makeRunState({ issue_state: 'closed', updated_at: oldTimestamp })],
        epics: [makeEpic({ status: 'completed', updated_at: oldTimestamp })],
        pullRequests: [],
      },
    ],
  });

  assert.equal(board.stale_cards, 0);
  assert.ok(board.columns.find((column) => column.id === 'closed')?.cards.every((card) => card.stale === false));
});

test('live refresh moves a locally coordinating epic to closed when its GitHub parent is closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-board-closed-epic-'));
  const workspaceRoot = path.join(root, 'workspace');
  const workflowPath = await writeWorkflow(root, workspaceRoot, 'mdedit');
  await writeEpicStates(workspaceRoot, [makeEpic({ updated_at: '2026-07-01T00:00:00.000Z' })]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/100') {
      return new Response(JSON.stringify({
        id: 100,
        node_id: 'epic-1',
        number: 100,
        title: 'Epic parent',
        state: 'closed',
        labels: [{ name: 'ready-for-human' }],
        html_url: 'https://github.test/mangoappstudio/mdedit/issues/100',
        updated_at: '2026-07-08T11:00:00.000Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch GET ${url}`);
  };

  try {
    const board = await loadBoardState({ workflow: workflowPath, refreshMs: 5000, liveRefresh: true, now: NOW });
    assert.equal(board.columns.find((column) => column.id === 'active')?.cards.length, 0);
    assert.equal(board.columns.find((column) => column.id === 'closed')?.cards[0]?.status, 'epic:completed');
    assert.equal(board.columns.find((column) => column.id === 'closed')?.cards[0]?.issue_state, 'closed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('loads board state from multi-repo server config and preserves repo ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-board-state-'));
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  const workflowA = await writeWorkflow(root, workspaceA, 'repo-a');
  const workflowB = await writeWorkflow(root, workspaceB, 'repo-b');
  const configPath = path.join(root, 'symphony.config.yml');
  await fs.writeFile(
    configPath,
    `repos:
  - id: alpha
    workflow: ${workflowA}
    enabled: true
  - id: beta
    workflow: ${workflowB}
    enabled: true
`,
    'utf8',
  );
  const workspaceIssueA = path.join(workspaceA, 'issue-a');
  const workspaceIssueB = path.join(workspaceB, 'issue-b');
  await writeRunState(workspaceIssueA, makeRunState({ repo_id: null, repo: null, issue_number: 1, issue_identifier: 'mangoappstudio/repo-a#1', workspace_path: workspaceIssueA }));
  await writeRunState(workspaceIssueB, makeRunState({ repo_id: null, repo: null, issue_number: 2, issue_identifier: 'mangoappstudio/repo-b#2', workspace_path: workspaceIssueB }));

  const board = await loadBoardState({ config: configPath, refreshMs: 5000, now: NOW });
  const repoIds = board.columns.flatMap((column) => column.cards.map((card) => card.repo_id)).sort();

  assert.deepEqual(repoIds, ['alpha', 'beta']);
  assert.equal(board.source.kind, 'config');
  assert.equal(board.total_cards, 2);
});
