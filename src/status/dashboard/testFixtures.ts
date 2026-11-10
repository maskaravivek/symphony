/** Shared on-disk fixture for the dashboard read-model and server tests. Not used at runtime. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EpisodeStore } from '../../episodes/episodeStore.js';
import type { OrchestratorHeartbeat, RepoHeartbeat } from '../dashboardTypes.js';
import { writeEpicStates, type EpicState } from '../epicState.js';
import { writeRunState, type RunState } from '../runState.js';
import { clearDashboardSourceCache } from './sources.js';

export const FIXTURE_NOW = new Date('2026-11-10T12:00:00.000Z');

export interface DashboardFixture {
  root: string;
  workspaceRoot: string;
  workflowPath: string;
  configPath: string;
  sessionDir: string;
}

const minutesAgo = (minutes: number) => new Date(FIXTURE_NOW.getTime() - minutes * 60_000).toISOString();

export function fixtureRunState(workspacePath: string, overrides: Partial<RunState> = {}): RunState {
  const issueNumber = overrides.issue_number === undefined ? 1 : overrides.issue_number;
  return {
    repo_id: 'x',
    owner: 'acme',
    repo: 'widget',
    issue_id: `issue-${issueNumber}`,
    issue_number: issueNumber,
    issue_identifier: `acme/widget#${issueNumber}`,
    issue_url: `https://github.test/acme/widget/issues/${issueNumber}`,
    issue_title: `Issue ${issueNumber}`,
    issue_state: 'open',
    labels: ['agent-running', 'feature:alpha'],
    workflow_state: 'agent-running',
    workspace_path: workspacePath,
    workspace_strategy: 'pooled_isolated',
    attempt: 1,
    session_id: 'sess-1',
    agent_provider: 'codex',
    agent_provider_group: 'codex',
    agent_provider_kind: 'codex',
    agent_thread_id: 'thread-1',
    agent_mode: 'autonomous',
    agent_log_path: null,
    codex_thread_id: 'thread-1',
    codex_mode: 'autonomous',
    pause_reason: null,
    worker_pid: null,
    status: 'agent-running',
    started_at: minutesAgo(5),
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
    updated_at: minutesAgo(2),
    ...overrides,
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Builds a single-repo install (repo id `x`, acme/widget) with: a running pool slot (#1) with a
 * session, a failed pool slot (#2, retries exhausted), a needs-info dedicated slot (#3), a
 * protected idle pool slot, a completed `daily` loop, a coordinating epic (#10), episodes,
 * heartbeats and storage status.
 */
export async function createDashboardFixture(): Promise<DashboardFixture> {
  clearDashboardSourceCache();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-dashboard-fixture-'));
  const workspaceRoot = path.join(root, 'workspaces');
  const workflowPath = path.join(root, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  owner: acme
  repo: widget
  token: test
  terminal_states: [closed]
  required_labels: [ready-for-agent]
  ignored_labels: [blocked, ready-for-human, wontfix]
workspace:
  root: ${workspaceRoot}
  storage_maintenance:
    max_pool_slots: 3
    warm_pool_slots: 1
agent:
  max_concurrent_agents: 2
  max_attempts: 3
agents:
  default: codex
  providers:
    codex:
      command: 'true'
loops:
  - id: daily
    interval_ms: 86400000
    prompt: Tidy up
---
Prompt
`,
    'utf8',
  );
  const configPath = path.join(root, 'symphony.config.yml');
  await fs.writeFile(configPath, `polling:\n  interval_ms: 60000\nagent:\n  max_concurrent_agents: 4\nrepos:\n  - id: x\n    workflow: WORKFLOW.md\n`, 'utf8');

  // Pool slot 1: running #1 with one session.
  const pool1 = path.join(workspaceRoot, '_pool_1');
  const sessionDir = path.join(pool1, '.symphony', 'runs', '2026-11-10T11-55-00-000Z-1-sess-1');
  await writeJson(path.join(sessionDir, 'manifest.json'), {
    version: 1,
    session_id: 'sess-1',
    issue_identifier: 'acme/widget#1',
    issue_number: 1,
    attempt: 1,
    mode: 'autonomous',
    provider: 'codex',
    created_at: minutesAgo(5),
    phase: 'agent-running',
    agent_outcome: null,
    workflow_outcome: null,
    prompt_path: path.join(sessionDir, 'prompt.md'),
    agent_log_path: path.join(sessionDir, 'agent.jsonl'),
    last_message_path: path.join(sessionDir, 'last_message.md'),
  });
  await fs.writeFile(path.join(sessionDir, 'prompt.md'), 'Do the thing\n', 'utf8');
  await fs.writeFile(
    path.join(sessionDir, 'agent.jsonl'),
    [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Reading the code' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 } },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
    'utf8',
  );
  await writeRunState(
    pool1,
    fixtureRunState(pool1, {
      session_artifact_dir: sessionDir,
      agent_log_path: path.join(sessionDir, 'agent.jsonl'),
      prompt_path: path.join(sessionDir, 'prompt.md'),
    }),
  );

  // Pool slot 2: #2 failed on its last attempt.
  const pool2 = path.join(workspaceRoot, '_pool_2');
  await writeRunState(
    pool2,
    fixtureRunState(pool2, {
      issue_number: 2,
      issue_id: 'issue-2',
      issue_identifier: 'acme/widget#2',
      issue_url: 'https://github.test/acme/widget/issues/2',
      issue_title: 'Issue 2',
      labels: ['symphony-failed'],
      workflow_state: 'symphony-failed',
      status: 'failed',
      attempt: 3,
      last_error: 'nonzero_exit: 1',
      updated_at: minutesAgo(90),
    }),
  );

  // Pool slot 3: idle but protected (heartbeat says so).
  const pool3 = path.join(workspaceRoot, '_pool_3');
  await fs.mkdir(pool3, { recursive: true });

  // Dedicated slot for #3: paused waiting for info.
  const dedicated = path.join(workspaceRoot, 'acme_widget_3');
  await writeRunState(
    dedicated,
    fixtureRunState(dedicated, {
      issue_number: 3,
      issue_id: 'issue-3',
      issue_identifier: 'acme/widget#3',
      issue_url: 'https://github.test/acme/widget/issues/3',
      issue_title: 'Issue 3',
      labels: ['needs-info'],
      workflow_state: 'needs-info',
      status: 'paused',
      pause_reason: 'needs-info',
      updated_at: minutesAgo(30),
    }),
  );

  // Loop `daily`: completed an hour ago.
  const loopDir = path.join(workspaceRoot, '_loops', 'daily');
  await writeRunState(
    loopDir,
    fixtureRunState(loopDir, {
      loop_id: 'daily',
      loop_run_id: 'run-1',
      loop_run_started_at: minutesAgo(70),
      issue_id: 'loop:daily',
      issue_number: null,
      issue_identifier: 'acme/widget#loop-daily',
      issue_url: null,
      issue_title: null,
      labels: [],
      workflow_state: null,
      status: 'completed',
      workflow_outcome: 'completed',
      started_at: minutesAgo(70),
      finished_at: minutesAgo(60),
      updated_at: minutesAgo(60),
    }),
  );

  const epic: EpicState = {
    repo_id: 'x',
    owner: 'acme',
    repo: 'widget',
    issue_id: 'issue-10',
    issue_number: 10,
    issue_identifier: 'acme/widget#10',
    issue_url: 'https://github.test/acme/widget/issues/10',
    title: 'Epic 10',
    labels: ['epic'],
    status: 'coordinating',
    open_children: 1,
    terminal_children: 1,
    total_children: 2,
    children: [1, 2].map((number) => ({
      issue_id: `issue-${number}`,
      issue_number: number,
      issue_identifier: `acme/widget#${number}`,
      issue_url: `https://github.test/acme/widget/issues/${number}`,
      title: `Issue ${number}`,
      state: number === 1 ? 'open' : 'closed',
      labels: [],
      depth: 1,
      leaf: true,
      queued: number === 1,
      skipped_reason: null,
    })),
    status_comment_id: null,
    updated_at: minutesAgo(10),
  };
  await writeEpicStates(workspaceRoot, [epic]);

  const store = new EpisodeStore(path.join(workspaceRoot, '.symphony', 'episodes.sqlite'));
  try {
    const event = (episode_id: string, name: string, payload: Record<string, unknown>, minutes: number) =>
      store.append({ repo_id: 'x', episode_id, event: name, payload, created_at: minutesAgo(minutes) });
    event('acme/widget#3:attempt:1', 'workflow.started', { issue_number: 3, attempt: 1, mode: 'autonomous', provider: 'codex' }, 3 * 24 * 60);
    event('pr-4', 'merge.merged', { pr_number: 4, issue_number: 3, risk: 'standard' }, 2 * 24 * 60);
    event('acme/widget#2:attempt:1', 'workflow.retry_scheduled', { issue_number: 2, attempt: 2, delay_ms: 10_000, reason: 'nonzero_exit: 1' }, 200);
    event('acme/widget#2:attempt:2', 'workflow.retry_scheduled', { issue_number: 2, attempt: 3, delay_ms: 20_000, reason: 'nonzero_exit: 1' }, 150);
    event('acme/widget#2:attempt:3', 'workflow.failed', { issue_number: 2, attempt: 3, max_attempts: 3, reason: 'nonzero_exit: 1' }, 90);
    event('loop-daily', 'loop.triggered', { loop_id: 'daily' }, 70);
    event('loop-daily', 'loop.completed', { loop_id: 'daily', exit_code: 0 }, 60);
    event('acme/widget#1:attempt:1', 'workflow.started', { issue_number: 1, attempt: 1, mode: 'autonomous', provider: 'codex' }, 5);
    event('pr-5', 'merge.blocked', { pr_number: 5, issue_number: 1, reasons: ['check is not successful: test (in_progress)', 'requires 1 review'] }, 1);
    store.upsertRetry({
      repo_id: 'x',
      issue_id: 'issue-7',
      issue_number: 7,
      issue_identifier: 'acme/widget#7',
      attempt: 2,
      reason: 'preparation_error: Linked workspace contains protected work',
      next_run_at: new Date(FIXTURE_NOW.getTime() + 60_000).toISOString(),
      workspace_path: null,
      mode: 'autonomous',
    });
  } finally {
    store.close();
  }

  const repoHeartbeat: RepoHeartbeat = {
    version: 1,
    repo_id: 'x',
    owner: 'acme',
    repo: 'widget',
    pid: process.pid,
    tick_started_at: minutesAgo(1),
    tick_finished_at: minutesAgo(1),
    tick_outcome: 'ok',
    tick_skip_reason: null,
    tick_error: null,
    poll: { candidate_count: 1, grooming_count: 0, active_count: 1, retry_count: 1, capacity_remaining: 1 },
    capacity: { max_concurrent_agents: 2, running: 1 },
    storage: { blocked: false, minimum_free_gib: 20, free_gib: 120 },
    github_rate_limit_backoff_until: null,
    provider_backoff: [],
    dispatch_deferrals: [{ at: minutesAgo(1), reason: 'workspace pool limit reached', issue_number: 8 }],
    dispatch_blocks: [],
    protected_workspaces: [{ path: pool3, issue_number: 6, reason: 'Preserving protected linked workspace' }],
  };
  await writeJson(path.join(workspaceRoot, '.symphony', 'heartbeat.json'), repoHeartbeat);
  await writeJson(path.join(workspaceRoot, '.symphony', 'storage-status.json'), { blocked: false, minimum_free_gib: 20 });
  await writeJson(path.join(workspaceRoot, '.symphony', 'storage-maintenance.json'), { completed_at_ms: FIXTURE_NOW.getTime(), artifact_bytes_removed: 0, workspaces_removed: 0 });

  const orchestratorHeartbeat: OrchestratorHeartbeat = {
    version: 1,
    pid: process.pid,
    started_at: minutesAgo(120),
    updated_at: minutesAgo(1),
    mode: 'config',
    source_path: configPath,
    polling_interval_ms: 60_000,
    max_concurrent_agents: 4,
    repo_ids: ['x'],
    shutting_down: false,
  };
  await writeJson(path.join(root, '.symphony', 'heartbeat.json'), orchestratorHeartbeat);

  return { root, workspaceRoot, workflowPath, configPath, sessionDir };
}
