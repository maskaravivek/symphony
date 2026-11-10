import fs from 'node:fs/promises';
import path from 'node:path';

import { readAgentUsage } from '../../dashboard/agentLog.js';
import { readArtifactChunk, type ArtifactAccess } from '../../dashboard/artifacts.js';
import type { GroomingSummary, LoopSummary, SessionSummary, TaskCommands, TaskDetail, TaskSummary } from '../dashboardTypes.js';
import type { RunState } from '../runState.js';
import { DashboardNotFoundError, loadLocal, type ReadModelOptions } from './context.js';
import { EpisodeReader } from './episodeReader.js';
import { buildTimeline } from './episodeSummary.js';
import { artifactPathsFor, taskKeyForIssue, taskKeyForLoop } from './localState.js';
import { buildPullRequests } from './repoState.js';
import { findRepoSource, type DashboardSources } from './sources.js';

export const TIMELINE_LIMIT = 500;
export const SESSIONS_SCAN_LIMIT = 40;
const SESSION_USAGE_LIMIT = 10;
const TEXT_READ_LIMIT = 512 * 1024;

export type TaskRef = number | { loopId: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function readText(access: ArtifactAccess, file: string | null): Promise<string | null> {
  if (!file) return null;
  return readArtifactChunk(access, file, { limit: TEXT_READ_LIMIT })
    .then(chunk => chunk.truncated ? null : chunk.content)
    .catch(() => null);
}

async function readJsonRecord(access: ArtifactAccess, file: string | null): Promise<Record<string, unknown> | null> {
  const text = await readText(access, file);
  if (text === null) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Parses the `SYMPHONY_GROOMING_RESULT` block a grooming run leaves in last_message.md. */
export function parseGroomingMessage(text: string): GroomingSummary | null {
  const markers = [...text.matchAll(/^SYMPHONY_GROOMING_RESULT[ \t]*$/gm)];
  const marker = markers[markers.length - 1];
  if (marker?.index === undefined) return null;
  let body = text.slice(marker.index + marker[0].length);
  const end = body.indexOf('END_SYMPHONY_GROOMING_RESULT');
  if (end !== -1) body = body.slice(0, end);
  const start = body.indexOf('{');
  const stop = body.lastIndexOf('}');
  if (start === -1 || stop <= start) return null;
  try {
    const raw = asRecord(JSON.parse(body.slice(start, stop + 1)));
    return raw ? groomingFromRecord(raw) : null;
  } catch {
    return null;
  }
}

function groomingFromRecord(raw: Record<string, unknown>): GroomingSummary {
  return { outcome: str(raw.outcome), summary: str(raw.summary), scope: str(raw.scope), raw };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./~:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Same resume/exec hints as `symphony open`. */
export function commandsFor(state: RunState | null, workspacePath: string | null): TaskCommands {
  const commands: TaskCommands = {
    cd: workspacePath ? `cd ${shellQuote(workspacePath)}` : null,
    resume: null,
    exec: null,
    editor_url: workspacePath ? `vscode://file${workspacePath.startsWith('/') ? '' : '/'}${encodeURI(workspacePath)}` : null,
  };
  if (state) {
    const provider = state.agent_provider ?? 'codex';
    const isCodex = state.agent_provider_kind === 'codex' || provider === 'codex' || provider.startsWith('codex-');
    const threadId = state.agent_thread_id ?? state.codex_thread_id ?? null;
    if (isCodex && threadId) {
      commands.resume = `codex resume --include-non-interactive ${threadId}`;
      commands.exec = `codex exec resume ${threadId} -`;
    }
  }
  return commands;
}

async function listSessions(
  workspaces: string[],
  extraDirs: string[],
  matches: (manifest: Record<string, unknown>) => boolean,
  access: ArtifactAccess,
): Promise<SessionSummary[]> {
  const dirs = new Set<string>(extraDirs);
  for (const workspace of workspaces) {
    const runsDir = path.join(workspace, '.symphony', 'runs');
    const names = await fs.readdir(runsDir).catch(() => [] as string[]);
    for (const name of names.sort().reverse().slice(0, SESSIONS_SCAN_LIMIT)) dirs.add(path.join(runsDir, name));
  }
  const sessions = (
    await Promise.all(
      [...dirs].map(async (dir): Promise<SessionSummary | null> => {
        const manifest = await readJsonRecord(access, path.join(dir, 'manifest.json'));
        if (!manifest || !matches(manifest)) return null;
        const agentLog = str(manifest.agent_log_path);
        return {
          session_id: str(manifest.session_id) ?? path.basename(dir),
          attempt: typeof manifest.attempt === 'number' ? manifest.attempt : null,
          mode: str(manifest.mode),
          provider: str(manifest.provider),
          created_at: str(manifest.created_at),
          finished_at: str(manifest.finished_at),
          phase: str(manifest.phase),
          agent_outcome: str(manifest.agent_outcome),
          workflow_outcome: str(manifest.workflow_outcome),
          artifact_dir: dir,
          artifacts: {
            prompt: str(manifest.prompt_path),
            agent_log: agentLog,
            agent_stderr: path.join(dir, 'agent.stderr.log'),
            last_message: str(manifest.last_message_path),
            verification: path.join(dir, 'verification.json'),
            manifest: path.join(dir, 'manifest.json'),
          },
          usage: null,
        };
      }),
    )
  ).filter((session): session is SessionSummary => session !== null);
  sessions.sort((a, b) => (b.created_at ?? b.artifact_dir).localeCompare(a.created_at ?? a.artifact_dir));
  await Promise.all(
    sessions.slice(0, SESSION_USAGE_LIMIT).map(async (session) => {
      if (session.artifacts.agent_log) session.usage = await readAgentUsage(access, session.artifacts.agent_log).catch(() => null);
    }),
  );
  return sessions;
}

export async function loadTaskDetail(sources: DashboardSources, repoId: string, ref: TaskRef, options: ReadModelOptions = {}): Promise<TaskDetail> {
  const repo = findRepoSource(sources, repoId);
  if (!repo) throw new DashboardNotFoundError(`unknown repo: ${repoId}`);
  const now = options.now ?? new Date();
  const local = await loadLocal(sources, repo, { ...options, now });
  const access: ArtifactAccess = { allowedRoots: sources.allowed_roots, symphonyArtifactsOnly: true };

  let task: TaskSummary | undefined;
  let loop: LoopSummary | null = null;
  if (typeof ref === 'number') {
    const key = taskKeyForIssue(repoId, local.pr_to_issue.get(ref) ?? ref);
    task = local.tasks.find((candidate) => candidate.task_key === key) ?? local.tasks.find((candidate) => candidate.pr_number === ref);
    if (!task) throw new DashboardNotFoundError(`no run state, epic, or loop for ${repoId}#${ref}`);
  } else {
    loop = local.loops.find((candidate) => candidate.loop_id === ref.loopId) ?? null;
    const key = taskKeyForLoop(repoId, ref.loopId);
    task = local.tasks.find((candidate) => candidate.task_key === key);
    // Every configured loop has a task (derived from loop episodes when run.json is gone).
    if (!loop || !task) throw new DashboardNotFoundError(`no loop ${ref.loopId} in ${repoId}`);
  }

  const runs = local.task_runs.get(task.task_key) ?? [];
  const runState = runs[0] ?? null;
  const numbers = new Set<number>();
  if (task.issue_number !== null) numbers.add(task.issue_number);
  if (task.pr_number !== null) numbers.add(task.pr_number);
  for (const run of runs) if (run.issue_number !== null) numbers.add(run.issue_number);
  for (const [pr, issue] of local.pr_to_issue) if (task.issue_number !== null && issue === task.issue_number) numbers.add(pr);

  const reader = EpisodeReader.open(repo.workspace_root);
  let events;
  try {
    events = reader.listEvents({
      numbers: task.loop_id ? [] : [...numbers],
      loopIds: task.loop_id ? [task.loop_id] : [],
      limit: TIMELINE_LIMIT,
      order: 'asc',
    });
  } finally {
    reader.close();
  }

  const workspaces = [...new Set([...runs.map((run) => run.workspace_path), ...(loop ? [loop.workspace_path] : [])].filter(Boolean))];
  const extraDirs = runs.map((run) => run.session_artifact_dir).filter((dir): dir is string => Boolean(dir));
  const sessions = await listSessions(
    workspaces,
    extraDirs,
    (manifest) => {
      if (task!.loop_id) return true;
      const issue = typeof manifest.issue_number === 'number' ? manifest.issue_number : null;
      return issue === null || numbers.has(issue);
    },
    access,
  );

  const artifacts = artifactPathsFor(runState);
  let grooming: GroomingSummary | null = null;
  const groomingCandidates = [
    runState?.last_message_path ?? null,
    ...sessions.filter((session) => session.mode === 'grooming').map((session) => session.artifacts.last_message),
  ];
  for (const candidate of [...new Set(groomingCandidates)]) {
    const text = await readText(access, candidate);
    grooming = text ? parseGroomingMessage(text) : null;
    if (grooming) break;
  }
  if (!grooming && runState?.grooming_result) grooming = groomingFromRecord(runState.grooming_result as unknown as Record<string, unknown>);

  const verification = await readJsonRecord(access, artifacts.verification);
  const pullRequest = task.pr_number !== null ? (buildPullRequests(local).find((pr) => pr.number === task!.pr_number) ?? null) : null;
  const epic = local.epics.find((candidate) => candidate.task_key === task!.task_key) ?? null;
  loop ??= task.loop_id ? (local.loops.find((candidate) => candidate.loop_id === task!.loop_id) ?? null) : null;

  return {
    generated_at: now.toISOString(),
    task,
    run_state: runState,
    timeline: buildTimeline(events),
    sessions,
    artifacts,
    grooming,
    verification,
    pull_request: pullRequest,
    epic,
    loop,
    commands: commandsFor(runState, task.workspace_path ?? runState?.workspace_path ?? loop?.workspace_path ?? null),
  };
}
