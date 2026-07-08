import path from 'node:path';

import { readEpicStates, type EpicState } from './epicState.js';
import { scanRunStates } from './scanRunStates.js';
import type { RunState } from './runState.js';
import { loadServerConfigFromFile } from '../server/loadServerConfig.js';
import { loadWorkflowFromFile } from '../workflow/loadWorkflow.js';
import { resolveWorkflowPath } from '../workflow/resolveWorkflowPath.js';
import type { WorkflowConfig } from '../workflow/types.js';

export const BOARD_COLUMNS = [
  { id: 'active', title: 'Active' },
  { id: 'needs-info', title: 'Needs Info' },
  { id: 'blocked', title: 'Blocked' },
  { id: 'review-blocked', title: 'Review Blocked' },
  { id: 'ready-for-review', title: 'Ready for Review' },
  { id: 'waiting-human', title: 'Waiting for Human' },
  { id: 'queued', title: 'Queued' },
  { id: 'closed', title: 'Closed' },
  { id: 'failed-cancelled', title: 'Failed / Cancelled' },
  { id: 'epics', title: 'Epics' },
] as const;

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]['id'];
export type BoardCardKind = 'run' | 'epic';

export interface BoardArtifactPaths {
  prompt: string | null;
  agent_log: string | null;
  last_message: string | null;
  codex_jsonl: string | null;
}

export interface BoardCard {
  id: string;
  kind: BoardCardKind;
  column: BoardColumnId;
  repo_id: string | null;
  owner: string | null;
  repo: string | null;
  issue_number: number | null;
  issue_identifier: string;
  issue_url: string | null;
  title: string | null;
  labels: string[];
  status: string;
  workflow_state: string | null;
  issue_state: string | null;
  pause_reason: string | null;
  agent_provider: string | null;
  agent_mode: string | null;
  attempt: number | null;
  thread_id: string | null;
  updated_at: string;
  last_error: string | null;
  workspace_path: string | null;
  artifacts: BoardArtifactPaths;
  review_auto_fix_iteration: number | null;
  epic_progress: string | null;
  stale: boolean;
}

export interface BoardColumn {
  id: BoardColumnId;
  title: string;
  cards: BoardCard[];
}

export interface BoardState {
  generated_at: string;
  source: {
    kind: 'workflow' | 'config';
    path: string;
  };
  refresh_ms: number;
  stale_after_ms: number;
  total_cards: number;
  stale_cards: number;
  columns: BoardColumn[];
}

interface BoardRepoSource {
  repoId: string | null;
  workflowPath: string;
  config: WorkflowConfig;
  runs: RunState[];
  epics: EpicState[];
}

export interface BuildBoardStateOptions {
  source: BoardState['source'];
  repos: BoardRepoSource[];
  refreshMs: number;
  staleAfterMs?: number;
  now?: Date;
}

export interface LoadBoardStateOptions {
  config?: string;
  workflow?: string;
  refreshMs: number;
  staleAfterMs?: number;
  now?: Date;
}

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

function labelsFor(state: { labels?: string[] | null }): string[] {
  return [...new Set((state.labels ?? []).map((label) => label.trim().toLowerCase()).filter(Boolean))].sort();
}

function hasLabel(labels: string[], label: string): boolean {
  return labels.includes(label);
}

function reviewAutoFixIteration(labels: string[]): number | null {
  let highest: number | null = null;
  for (const label of labels) {
    const match = /^symphony-review:auto-fix-(\d+)$/.exec(label);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isInteger(value)) continue;
    highest = highest === null ? value : Math.max(highest, value);
  }
  return highest;
}

function isStale(updatedAt: string, now: Date, staleAfterMs: number): boolean {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return false;
  return now.getTime() - updatedMs > staleAfterMs;
}

export function classifyRunState(state: RunState, terminalStates: string[]): BoardColumnId {
  const labels = labelsFor(state);
  const workflowState = state.workflow_state?.trim().toLowerCase() ?? null;
  const issueState = state.issue_state?.trim().toLowerCase() ?? null;
  const terminal = new Set(terminalStates.map((value) => value.trim().toLowerCase()));

  if (state.status === 'running' || workflowState === 'agent-running') return 'active';
  if (state.pause_reason === 'needs-info' || hasLabel(labels, 'needs-info')) return 'needs-info';
  if (hasLabel(labels, 'blocked') || workflowState === 'blocked') return 'blocked';
  if (hasLabel(labels, 'symphony-review:blocking')) return 'review-blocked';
  if (hasLabel(labels, 'symphony-review:passed') || (state.agent_mode === 'pr-review' && workflowState === 'ready-for-human')) {
    return 'ready-for-review';
  }
  if (hasLabel(labels, 'ready-for-human') || workflowState === 'ready-for-human' || state.pause_reason === 'interactive') {
    return 'waiting-human';
  }
  if (hasLabel(labels, 'ready-for-agent') || workflowState === 'ready-for-agent') return 'queued';
  if (issueState && terminal.has(issueState)) return 'closed';
  if (state.status === 'failed' || state.status === 'cancelled') return 'failed-cancelled';
  if (state.status === 'completed') return 'waiting-human';
  return 'queued';
}

function repoIdFor(state: RunState, source: BoardRepoSource): string | null {
  return state.repo_id ?? source.repoId;
}

function ownerFor(state: RunState, source: BoardRepoSource): string | null {
  return state.owner ?? source.config.tracker.owner ?? null;
}

function repoFor(state: RunState, source: BoardRepoSource): string | null {
  return state.repo ?? source.config.tracker.repo ?? null;
}

function runCard(source: BoardRepoSource, state: RunState, now: Date, staleAfterMs: number): BoardCard {
  const labels = labelsFor(state);
  return {
    id: `run:${repoIdFor(state, source) ?? ownerFor(state, source) ?? ''}/${repoFor(state, source) ?? ''}:${state.issue_identifier}`,
    kind: 'run',
    column: classifyRunState(state, source.config.tracker.terminal_states),
    repo_id: repoIdFor(state, source),
    owner: ownerFor(state, source),
    repo: repoFor(state, source),
    issue_number: state.issue_number,
    issue_identifier: state.issue_identifier,
    issue_url: state.issue_url,
    title: state.issue_title ?? null,
    labels,
    status: state.status,
    workflow_state: state.workflow_state ?? null,
    issue_state: state.issue_state ?? null,
    pause_reason: state.pause_reason ?? null,
    agent_provider: state.agent_provider ?? null,
    agent_mode: state.agent_mode ?? state.codex_mode ?? null,
    attempt: state.attempt,
    thread_id: state.agent_thread_id ?? state.codex_thread_id ?? null,
    updated_at: state.updated_at,
    last_error: state.last_error,
    workspace_path: state.workspace_path,
    artifacts: {
      prompt: state.prompt_path,
      agent_log: state.agent_log_path ?? state.agent_output_path ?? state.codex_jsonl_path ?? null,
      last_message: state.last_message_path,
      codex_jsonl: state.codex_jsonl_path,
    },
    review_auto_fix_iteration: reviewAutoFixIteration(labels),
    epic_progress: null,
    stale: isStale(state.updated_at, now, staleAfterMs),
  };
}

function epicCard(source: BoardRepoSource, state: EpicState, now: Date, staleAfterMs: number): BoardCard {
  const labels = labelsFor(state);
  return {
    id: `epic:${state.issue_identifier}`,
    kind: 'epic',
    column: state.status === 'completed' ? 'closed' : 'epics',
    repo_id: state.repo_id ?? source.repoId,
    owner: state.owner ?? source.config.tracker.owner,
    repo: state.repo ?? source.config.tracker.repo,
    issue_number: state.issue_number,
    issue_identifier: state.issue_identifier,
    issue_url: state.issue_url,
    title: state.title,
    labels,
    status: `epic:${state.status}`,
    workflow_state: state.status,
    issue_state: state.status === 'completed' ? 'closed' : null,
    pause_reason: null,
    agent_provider: null,
    agent_mode: null,
    attempt: null,
    thread_id: null,
    updated_at: state.updated_at,
    last_error: null,
    workspace_path: null,
    artifacts: {
      prompt: null,
      agent_log: null,
      last_message: null,
      codex_jsonl: null,
    },
    review_auto_fix_iteration: null,
    epic_progress: `${state.terminal_children}/${state.total_children}`,
    stale: isStale(state.updated_at, now, staleAfterMs),
  };
}

function cardSort(a: BoardCard, b: BoardCard): number {
  const repoCompare = (a.repo_id ?? a.repo ?? '').localeCompare(b.repo_id ?? b.repo ?? '');
  if (repoCompare !== 0) return repoCompare;
  const updatedCompare = b.updated_at.localeCompare(a.updated_at);
  if (updatedCompare !== 0) return updatedCompare;
  return (a.issue_number ?? Number.POSITIVE_INFINITY) - (b.issue_number ?? Number.POSITIVE_INFINITY);
}

export function buildBoardState(options: BuildBoardStateOptions): BoardState {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const cards = options.repos.flatMap((source) => [
    ...source.runs.map((state) => runCard(source, state, now, staleAfterMs)),
    ...source.epics.map((state) => epicCard(source, state, now, staleAfterMs)),
  ]);
  const byColumn = new Map<BoardColumnId, BoardCard[]>();
  for (const card of cards) {
    const column = byColumn.get(card.column) ?? [];
    column.push(card);
    byColumn.set(card.column, column);
  }

  return {
    generated_at: now.toISOString(),
    source: options.source,
    refresh_ms: options.refreshMs,
    stale_after_ms: staleAfterMs,
    total_cards: cards.length,
    stale_cards: cards.filter((card) => card.stale).length,
    columns: BOARD_COLUMNS.map((column) => ({
      ...column,
      cards: [...(byColumn.get(column.id) ?? [])].sort(cardSort),
    })),
  };
}

async function loadRepoSource(repoId: string | null, workflowPath: string): Promise<BoardRepoSource> {
  const loaded = await loadWorkflowFromFile(workflowPath);
  const [runs, epics] = await Promise.all([scanRunStates(loaded.config.workspace.root), readEpicStates(loaded.config.workspace.root)]);
  return {
    repoId,
    workflowPath,
    config: loaded.config,
    runs,
    epics,
  };
}

export async function loadBoardState(options: LoadBoardStateOptions): Promise<BoardState> {
  if (options.config) {
    const configPath = path.resolve(options.config);
    const serverConfig = await loadServerConfigFromFile(configPath);
    const repos = await Promise.all(
      serverConfig.repos.filter((repo) => repo.enabled).map((repo) => loadRepoSource(repo.id, repo.workflow)),
    );
    return buildBoardState({
      source: { kind: 'config', path: configPath },
      repos,
      refreshMs: options.refreshMs,
      staleAfterMs: options.staleAfterMs,
      now: options.now,
    });
  }

  const workflowPath = await resolveWorkflowPath(options.workflow ?? 'WORKFLOW.md');
  const source = await loadRepoSource(null, workflowPath);
  return buildBoardState({
    source: { kind: 'workflow', path: workflowPath },
    repos: [source],
    refreshMs: options.refreshMs,
    staleAfterMs: options.staleAfterMs,
    now: options.now,
  });
}
