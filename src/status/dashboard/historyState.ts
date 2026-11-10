import type { EpisodeEvent } from '../../episodes/episodeStore.js';
import type { EpisodeEventSummary, EventsPage, HistoryState, ReasonCount, RepoHistory, WeeklyStats } from '../dashboardTypes.js';
import { DashboardNotFoundError } from './context.js';
import { EpisodeReader, issueNumberFromEpisodeId, numberField, prNumberFromEpisodeId, stringField } from './episodeReader.js';
import { collapseEpisodeEvents, collapseWithGrowingWindow, summarizeEpisodeEvent } from './episodeSummary.js';
import { findRepoSource, type DashboardRepoSource, type DashboardSources } from './sources.js';

export const DEFAULT_HISTORY_DAYS = 28;
export const MAX_HISTORY_DAYS = 366;
export const DEFAULT_EVENTS_LIMIT = 100;
export const MAX_EVENTS_LIMIT = 500;
/** Raw rows read per page (x limit, capped) so collapsed repeats still fill the page. */
const RAW_WINDOW_FACTOR = 5;
const MAX_RAW_EVENTS = 2_500;
const HISTORY_EVENT_LIMIT = 5_000;
const DAY_MS = 86_400_000;

const HISTORY_EVENTS = [
  'merge.merged',
  'merge.blocked',
  'workflow.completed',
  'workflow.failed',
  'workflow.paused',
  'workflow.retry_scheduled',
  'loop.completed',
  'loop.failed',
];

/** ISO week start (Monday, UTC) as YYYY-MM-DD. */
export function isoWeekStart(at: Date): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
}

/** Strips everything after the first `:` and caps the result at 80 characters. */
export function normalizeReason(reason: string): string {
  const head = reason.split(':')[0] ?? reason;
  return head.trim().slice(0, 80);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function topReasons(counts: Map<string, number>, limit = 5): ReasonCount[] {
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, limit);
}

function bump(counts: Map<string, number>, reason: string | null): void {
  if (!reason) return;
  const key = normalizeReason(reason);
  if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
}

function emptyWeek(weekStart: string): WeeklyStats {
  return {
    week_start: weekStart,
    merged: 0,
    completed: 0,
    failed: 0,
    paused: 0,
    retries: 0,
    loops_completed: 0,
    loops_failed: 0,
    median_claim_to_merge_ms: null,
  };
}

function repoHistory(repo: DashboardRepoSource, from: Date, to: Date): RepoHistory {
  const weeks = new Map<string, WeeklyStats>();
  for (let at = from.getTime(); at <= to.getTime() + 7 * DAY_MS; at += 7 * DAY_MS) {
    const key = isoWeekStart(new Date(Math.min(at, to.getTime())));
    if (!weeks.has(key)) weeks.set(key, emptyWeek(key));
  }
  const retryReasons = new Map<string, number>();
  const failureReasons = new Map<string, number>();
  const mergeBlockReasons = new Map<string, number>();
  const seenBlocks = new Set<string>();
  const mergesByWeek = new Map<string, Array<{ issue: number; mergedMs: number }>>();

  const reader = EpisodeReader.open(repo.workspace_root);
  try {
    const events = reader.listEvents({ events: HISTORY_EVENTS, since: from.toISOString(), limit: HISTORY_EVENT_LIMIT });
    for (const event of events) {
      const at = new Date(event.created_at);
      if (!Number.isFinite(at.getTime()) || at > to) continue;
      const key = isoWeekStart(at);
      const week = weeks.get(key) ?? emptyWeek(key);
      weeks.set(key, week);
      const reason = stringField(event.payload.reason);
      switch (event.event) {
        case 'merge.merged': {
          week.merged += 1;
          const issue = numberField(event.payload.issue_number) ?? numberField(event.payload.pr_number) ?? prNumberFromEpisodeId(event.episode_id);
          if (issue !== null) {
            const list = mergesByWeek.get(key) ?? [];
            list.push({ issue, mergedMs: at.getTime() });
            mergesByWeek.set(key, list);
          }
          break;
        }
        case 'merge.blocked': {
          // The merge gate re-evaluates every poll; count each reason once per PR.
          const pr = numberField(event.payload.pr_number) ?? prNumberFromEpisodeId(event.episode_id) ?? -1;
          const reasons = Array.isArray(event.payload.reasons) ? event.payload.reasons : [];
          for (const value of reasons) {
            if (typeof value !== 'string') continue;
            const normalized = normalizeReason(value);
            const dedupe = `${pr}:${normalized}`;
            if (seenBlocks.has(dedupe)) continue;
            seenBlocks.add(dedupe);
            bump(mergeBlockReasons, value);
          }
          break;
        }
        case 'workflow.completed':
          week.completed += 1;
          break;
        case 'workflow.failed':
          week.failed += 1;
          bump(failureReasons, reason);
          break;
        case 'workflow.paused':
          week.paused += 1;
          break;
        case 'workflow.retry_scheduled':
          week.retries += 1;
          bump(retryReasons, reason);
          break;
        case 'loop.completed':
          week.loops_completed += 1;
          break;
        case 'loop.failed':
          week.loops_failed += 1;
          bump(failureReasons, reason ?? stringField(event.payload.error));
          break;
        default:
          break;
      }
    }

    const mergedIssues = [...new Set([...mergesByWeek.values()].flat().map((merge) => merge.issue))];
    if (mergedIssues.length > 0) {
      const firstStart = new Map<number, number>();
      const starts: EpisodeEvent[] = reader.listEvents({ events: ['workflow.started'], numbers: mergedIssues, limit: HISTORY_EVENT_LIMIT });
      for (const start of starts) {
        const issue = numberField(start.payload.issue_number) ?? issueNumberFromEpisodeId(start.episode_id);
        const ms = Date.parse(start.created_at);
        if (issue === null || !Number.isFinite(ms)) continue;
        firstStart.set(issue, Math.min(firstStart.get(issue) ?? ms, ms));
      }
      for (const [key, merges] of mergesByWeek) {
        const durations = merges
          .map((merge) => {
            const started = firstStart.get(merge.issue);
            return started !== undefined && started <= merge.mergedMs ? merge.mergedMs - started : null;
          })
          .filter((value): value is number => value !== null);
        const week = weeks.get(key);
        if (week) week.median_claim_to_merge_ms = median(durations);
      }
    }
  } finally {
    reader.close();
  }

  return {
    repo_id: repo.repo_id,
    weeks: [...weeks.values()].sort((a, b) => a.week_start.localeCompare(b.week_start)),
    top_retry_reasons: topReasons(retryReasons),
    top_failure_reasons: topReasons(failureReasons),
    top_merge_block_reasons: topReasons(mergeBlockReasons),
  };
}

export interface HistoryOptions {
  days?: number;
  repo?: string | null;
  now?: Date;
}

export async function loadHistoryState(sources: DashboardSources, options: HistoryOptions = {}): Promise<HistoryState> {
  const now = options.now ?? new Date();
  const days = Math.max(1, Math.min(Math.floor(options.days ?? DEFAULT_HISTORY_DAYS), MAX_HISTORY_DAYS));
  const from = new Date(now.getTime() - days * DAY_MS);
  const repos = selectRepos(sources, options.repo ?? null);
  return {
    generated_at: now.toISOString(),
    window: { from: from.toISOString(), to: now.toISOString(), days },
    repos: repos.map((repo) => repoHistory(repo, from, now)),
  };
}

function selectRepos(sources: DashboardSources, repoId: string | null): DashboardRepoSource[] {
  if (!repoId) return sources.repos;
  const repo = findRepoSource(sources, repoId);
  if (!repo) throw new DashboardNotFoundError(`unknown repo: ${repoId}`);
  return [repo];
}

export interface EventsPageOptions {
  repo?: string | null;
  /**
   * Opaque cursor from a previous page's `next_before`. For a single repo it is an episode
   * sequence; across repos it encodes a timestamp, repo ID, and sequence.
   */
  before?: number | string | null;
  limit?: number;
  /** `${repo_id}/${issue}` or `${repo_id}/loop/${loop_id}`. */
  task?: string | null;
  now?: Date;
}

export function parseTaskKey(taskKey: string): { repoId: string; issueNumber: number | null; loopId: string | null } | null {
  const loop = /^(.+)\/loop\/(.+)$/.exec(taskKey);
  if (loop) return { repoId: loop[1]!, issueNumber: null, loopId: loop[2]! };
  const issue = /^(.+)\/(\d+)$/.exec(taskKey);
  if (issue) return { repoId: issue[1]!, issueNumber: Number(issue[2]), loopId: null };
  return null;
}

export class InvalidEventsCursorError extends Error {
  readonly status = 400;
}

function parseEventsCursor(value: string): [number, string, number] {
  try {
    const cursor: unknown = JSON.parse(value);
    if (Array.isArray(cursor) && cursor.length === 3 && Number.isSafeInteger(cursor[0])
      && cursor[0] >= 0 && cursor[0] <= 8.64e15 && typeof cursor[1] === 'string'
      && Number.isSafeInteger(cursor[2]) && cursor[2] > 0) return [cursor[0], cursor[1], cursor[2]];
  } catch {
    // Report an invalid cursor below.
  }
  throw new InvalidEventsCursorError('Invalid events cursor');
}

function compareEvents(a: EpisodeEventSummary, b: EpisodeEventSummary): number {
  return b.created_at.localeCompare(a.created_at) || a.repo_id.localeCompare(b.repo_id) || b.sequence - a.sequence;
}

export async function loadEventsPage(sources: DashboardSources, options: EventsPageOptions = {}): Promise<EventsPage> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? DEFAULT_EVENTS_LIMIT), MAX_EVENTS_LIMIT));
  const task = options.task ? parseTaskKey(options.task) : null;
  if (options.task && !task) throw new DashboardNotFoundError(`invalid task key: ${options.task}`);
  const repoId = task?.repoId ?? options.repo ?? null;
  const repos = selectRepos(sources, repoId);
  const before = options.before ?? null;

  // Read a larger raw window so collapsed repeats still fill a page.
  const rawLimit = Math.min(limit * RAW_WINDOW_FACTOR, MAX_RAW_EVENTS);

  if (repoId) {
    if (typeof before === 'string') throw new InvalidEventsCursorError('Expected a repository event sequence');
    const repo = repos[0]!;
    const reader = EpisodeReader.open(repo.workspace_root);
    let result: ReturnType<typeof collapseWithGrowingWindow<EpisodeEvent>>;
    try {
      result = collapseWithGrowingWindow(
        (count) =>
          reader.listEvents({
            before: before ?? undefined,
            numbers: task?.issueNumber != null ? [task.issueNumber] : undefined,
            loopIds: task?.loopId ? [task.loopId] : undefined,
            limit: count,
          }),
        (event) => summarizeEpisodeEvent(event, repo.repo_id),
        limit,
        rawLimit,
        MAX_RAW_EVENTS,
      );
    } finally {
      reader.close();
    }
    const { events, consumed, rows: raw, window } = result;
    // The cursor is the oldest raw row consumed, so the next page starts right after it.
    const more = consumed < raw.length || raw.length === window;
    return {
      generated_at: now.toISOString(),
      events,
      next_before: more && consumed > 0 ? raw[consumed - 1]!.sequence : null,
    };
  }

  const cursor = typeof before === 'string' ? parseEventsCursor(before) : null;
  const epochMs = cursor?.[0] ?? (typeof before === 'number' ? before : null);
  if (epochMs !== null && (!Number.isSafeInteger(epochMs) || epochMs < 0 || epochMs > 8.64e15)) {
    throw new InvalidEventsCursorError('Invalid events cursor timestamp');
  }
  const createdBefore = epochMs === null ? undefined : new Date(epochMs).toISOString();
  let stream: EpisodeEventSummary[] = [];
  // A full window may have unread rows immediately below its oldest event.
  let horizon: EpisodeEventSummary | null = null;
  for (const repo of repos) {
    const reader = EpisodeReader.open(repo.workspace_root);
    try {
      const raw = reader.listEvents({
        createdBefore,
        includeCreatedBefore: cursor !== null && repo.repo_id.localeCompare(cursor[1]) > 0,
        sequenceAtCreatedBefore: cursor && repo.repo_id === cursor[1] ? cursor[2] : undefined,
        byTime: true,
        limit: rawLimit,
      });
      const rows = raw.map(event => summarizeEpisodeEvent(event, repo.repo_id));
      if (rows.length === rawLimit) {
        const oldest = rows[rows.length - 1]!;
        if (!horizon || compareEvents(oldest, horizon) < 0) horizon = oldest;
      }
      stream.push(...rows);
    } finally {
      reader.close();
    }
  }
  stream.sort(compareEvents);
  if (horizon) stream = stream.filter(event => compareEvents(event, horizon!) <= 0);
  const { events, consumed } = collapseEpisodeEvents(stream, limit);
  const more = consumed < stream.length || horizon !== null;
  const lastConsumed = consumed > 0 ? stream[consumed - 1] : undefined;
  return {
    generated_at: now.toISOString(),
    events,
    next_before: more && lastConsumed ? JSON.stringify([Date.parse(lastConsumed.created_at), lastConsumed.repo_id, lastConsumed.sequence]) : null,
  };
}
