import type { EpisodeEvent } from '../../episodes/episodeStore.js';
import type { EpisodeEventSummary, HealthLevel, TaskKey, TimelineEntry } from '../dashboardTypes.js';
import { issueNumberFromEpisodeId, loopIdFromEpisodeId, numberField, prNumberFromEpisodeId, stringField } from './episodeReader.js';

export function episodeEventLevel(event: string, payload: Record<string, unknown> = {}): HealthLevel {
  const name = event.toLowerCase();
  if (name === 'verification.received') {
    const receipt = payload.receipt && typeof payload.receipt === 'object' ? (payload.receipt as Record<string, unknown>) : payload;
    const verdict = typeof receipt.verdict === 'string' ? receipt.verdict.toLowerCase() : null;
    if (verdict === 'pass' || verdict === 'passed') return 'ok';
    if (verdict === 'fail' || verdict === 'failed') return 'bad';
    return 'unknown';
  }
  if (/(failed|blocked|exhausted)/.test(name) || payload.exhausted === true) return 'bad';
  if (/(retry|paused|deferred|requeued|repair|orphan)/.test(name)) return 'warn';
  if (/(merged|completed|approval_received|closed)/.test(name)) return 'ok';
  return 'unknown';
}

export function timelineKind(event: string): TimelineEntry['kind'] {
  if (event === 'workflow.retry_scheduled') return 'retry';
  const prefix = event.split('.')[0] ?? '';
  switch (prefix) {
    case 'run':
    case 'workflow':
    case 'agent':
    case 'pr':
    case 'merge':
    case 'verification':
    case 'repair':
    case 'loop':
    case 'issue':
      return prefix;
    default:
      return 'other';
  }
}

function truncate(value: string, length = 160): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > length ? `${single.slice(0, length - 1)}…` : single;
}

function formatDelay(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Subject of an event: "#123", "PR #45", or "loop daily". */
function subject(event: EpisodeEvent): string {
  const p = event.payload;
  const loopId = stringField(p.loop_id) ?? loopIdFromEpisodeId(event.episode_id);
  if (loopId) return `loop ${loopId}`;
  const pr = numberField(p.pr_number) ?? prNumberFromEpisodeId(event.episode_id);
  if (pr !== null) return `PR #${pr}`;
  const issue = numberField(p.issue_number) ?? issueNumberFromEpisodeId(event.episode_id);
  return issue !== null ? `#${issue}` : event.episode_id;
}

/** One human-readable line for an episode event; shared by task timelines and the events page. */
export function describeEpisodeEvent(event: EpisodeEvent): string {
  const p = event.payload;
  const who = subject(event);
  const reason = stringField(p.reason) ?? stringField(p.error);
  const mode = stringField(p.mode);
  const provider = stringField(p.provider);
  const attempt = numberField(p.attempt);
  const via = [provider, mode].filter(Boolean).join(' ');
  const attemptText = attempt !== null ? ` (attempt ${attempt}${numberField(p.max_attempts) ? `/${numberField(p.max_attempts)}` : ''})` : '';
  switch (event.event) {
    case 'workflow.started':
      return `${who}: workflow started${via ? ` with ${via}` : ''}${attemptText}`;
    case 'workflow.finalizing':
      return `${who}: finalizing`;
    case 'workflow.completed': {
      const outcome = stringField(p.outcome);
      const followups = stringList(p.followup_urls).length;
      return `${who}: workflow completed${outcome ? ` (${outcome})` : ''}${followups ? `, ${followups} follow-up${followups === 1 ? '' : 's'}` : ''}`;
    }
    case 'workflow.failed':
      return `${who}: workflow failed${attemptText}${reason ? `: ${truncate(reason)}` : ''}`;
    case 'workflow.paused':
      return `${who}: paused${reason ? ` (${truncate(reason)})` : ''}`;
    case 'workflow.requeued':
      return `${who}: requeued${reason ? `: ${truncate(reason)}` : ''}`;
    case 'workflow.retry_scheduled':
    case 'repair.scheduled': {
      const delay = numberField(p.delay_ms);
      const label = event.event === 'repair.scheduled' ? 'repair scheduled' : 'retry scheduled';
      return `${who}: ${label}${attemptText}${delay !== null ? ` in ${formatDelay(delay)}` : ''}${reason ? `: ${truncate(reason)}` : ''}`;
    }
    case 'repair.orphan_recovered':
      return `${who}: orphaned run recovered${reason ? ` (${truncate(reason)})` : ''}`;
    case 'agent.started':
    case 'run.started':
      return `${who}: agent started${via ? ` (${via})` : ''}${attemptText}`;
    case 'agent.completed':
    case 'run.completed':
      return `${who}: agent finished${numberField(p.exit_code) !== null ? ` with exit ${numberField(p.exit_code)}` : ''}`;
    case 'agent.failed':
    case 'run.failed': {
      const exit = numberField(p.exit_code);
      const signal = stringField(p.signal);
      const detail = exit !== null ? `exit ${exit}` : signal ? signal : reason ? truncate(reason) : null;
      return `${who}: agent failed${detail ? ` (${detail})` : ''}`;
    }
    case 'issue.closed':
      return `${who}: issue closed${stringField(p.run_status) ? ` (run ${stringField(p.run_status)})` : ''}`;
    case 'verification.received': {
      const receipt = p.receipt && typeof p.receipt === 'object' ? (p.receipt as Record<string, unknown>) : {};
      const verdict = stringField(receipt.verdict) ?? stringField(p.verdict);
      const verifier = stringField(receipt.verifier);
      return `${who}: verification ${verdict ?? 'received'}${verifier ? ` from ${verifier}` : ''}`;
    }
    case 'merge.merged':
      return `${who}: merged${stringField(p.risk) ? ` (${stringField(p.risk)} risk)` : ''}`;
    case 'merge.blocked': {
      const reasons = stringList(p.reasons);
      return `${who}: merge blocked${reasons.length ? `: ${truncate(reasons.join('; '))}` : ''}`;
    }
    case 'pr.feedback_queued': {
      const round = numberField(p.feedback_round);
      const max = numberField(p.max_feedback_rounds);
      return `${who}: review feedback queued${round !== null ? ` (round ${round}${max !== null ? `/${max}` : ''})` : ''}`;
    }
    case 'pr.feedback_exhausted':
      return `${who}: feedback rounds exhausted`;
    case 'pr.codex_approval_received':
      return `${who}: Codex approval received`;
    case 'loop.triggered':
      return `${who}: triggered`;
    case 'loop.completed':
      return `${who}: completed${numberField(p.exit_code) !== null ? ` with exit ${numberField(p.exit_code)}` : ''}`;
    case 'loop.failed':
      return `${who}: failed${reason ? `: ${truncate(reason)}` : ''}${stringField(p.error) && reason !== stringField(p.error) ? ` (${truncate(stringField(p.error)!)})` : ''}`;
    default: {
      const verb = event.event.replace(/[._]/g, ' ');
      return `${who}: ${verb}${reason ? `: ${truncate(reason)}` : ''}`;
    }
  }
}

function taskKeyFor(
  repoId: string,
  event: EpisodeEvent,
  issueNumber: number | null,
  prNumber: number | null,
  prToIssue: ReadonlyMap<number, number> | undefined,
): TaskKey | null {
  const loopId = stringField(event.payload.loop_id) ?? loopIdFromEpisodeId(event.episode_id);
  if (loopId) return `${repoId}/loop/${loopId}`;
  const number = issueNumber ?? prNumber;
  if (number === null) return null;
  return `${repoId}/${prToIssue?.get(number) ?? number}`;
}

/**
 * Converts a stored episode event into the API shape. `repoId` is the dashboard repo id, which
 * may differ from the stored `repo_id` (workflow mode stores `owner/repo`). `prToIssue` folds PR
 * numbers into their originating issue so task keys match the task list.
 */
export function summarizeEpisodeEvent(
  event: EpisodeEvent,
  repoId: string,
  prToIssue?: ReadonlyMap<number, number>,
): EpisodeEventSummary {
  const prNumber = numberField(event.payload.pr_number) ?? prNumberFromEpisodeId(event.episode_id);
  const issueNumber = numberField(event.payload.issue_number) ?? issueNumberFromEpisodeId(event.episode_id);
  return {
    sequence: event.sequence,
    repo_id: repoId,
    episode_id: event.episode_id,
    event: event.event,
    created_at: event.created_at,
    level: episodeEventLevel(event.event, event.payload),
    summary: describeEpisodeEvent(event),
    issue_number: issueNumber,
    pr_number: prNumber,
    task_key: taskKeyFor(repoId, event, issueNumber, prNumber, prToIssue),
    payload: event.payload,
  };
}

export function timelineEntry(event: EpisodeEvent): TimelineEntry {
  return {
    at: event.created_at,
    event: event.event,
    kind: timelineKind(event.event),
    level: episodeEventLevel(event.event, event.payload),
    summary: describeEpisodeEvent(event),
    payload: event.payload,
  };
}

/**
 * Timeline for a task: ascending, with runs of consecutive identical events (same event name and
 * reason, e.g. a retry loop on the same preparation error) collapsed into their latest entry.
 */
export function buildTimeline(events: EpisodeEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let previousKey: string | null = null;
  for (const event of events) {
    const reason = stringField(event.payload.reason) ?? stringField(event.payload.error) ?? '';
    const key = event.event.endsWith('started') || event.event.endsWith('completed') ? null : `${event.event}\u0000${reason}`;
    const last = entries[entries.length - 1];
    if (key !== null && key === previousKey && last) {
      const entry = timelineEntry(event);
      entries[entries.length - 1] = { ...entry, repeat_count: (last.repeat_count ?? 1) + 1, first_at: last.first_at ?? last.at };
    } else {
      entries.push(timelineEntry(event));
    }
    previousKey = key;
  }
  // The repeat count lives in repeat_count/first_at only; summary text stays the event's own line.
  return entries;
}

/**
 * Key under which identical events collapse in event lists. `issue.closed` is re-recorded on
 * every poll with an identical payload for already-closed issues, so it collapses per issue
 * regardless of summary; everything else collapses per episode and summary text.
 */
export function eventCollapseKey(event: EpisodeEventSummary): string {
  if (event.event === 'issue.closed' && event.issue_number !== null) return `${event.repo_id}\u0000issue.closed\u0000${event.issue_number}`;
  const subject = event.episode_id || String(event.issue_number ?? '');
  return `${event.repo_id}\u0000${event.event}\u0000${subject}\u0000${event.summary.trim().toLowerCase()}`;
}

export interface CollapsedEvents {
  events: EpisodeEventSummary[];
  /** How many raw rows (from the front of the input) the returned events account for. */
  consumed: number;
}

/**
 * Collapses newest-first events: each distinct key becomes one entry at its newest position,
 * carrying `repeat_count` and the oldest `first_at` among the rows consumed. Stops before the
 * first row that would start entry `limit + 1`, so `consumed` marks a safe paging cursor: every
 * unconsumed row is older than every consumed one.
 */
export function collapseEpisodeEvents(rows: EpisodeEventSummary[], limit: number): CollapsedEvents {
  const groups = new Map<string, EpisodeEventSummary>();
  let consumed = 0;
  for (const row of rows) {
    const key = eventCollapseKey(row);
    const existing = groups.get(key);
    if (existing) {
      existing.repeat_count = (existing.repeat_count ?? 1) + 1;
      existing.first_at = row.created_at;
    } else {
      if (groups.size >= limit) break;
      groups.set(key, { ...row });
    }
    consumed += 1;
  }
  return { events: [...groups.values()], consumed };
}

/**
 * Reads a raw window of `initial` rows, collapses it, and while repeats leave the page short of
 * `limit` entries and the window was full, re-reads a 4x larger window (up to `cap` rows).
 */
export function collapseWithGrowingWindow<T>(
  fetchRows: (count: number) => T[],
  toSummary: (row: T) => EpisodeEventSummary,
  limit: number,
  initial: number,
  cap: number,
): CollapsedEvents & { rows: T[]; window: number } {
  let window = Math.min(initial, cap);
  for (;;) {
    const rows = fetchRows(window);
    const collapsed = collapseEpisodeEvents(rows.map(toSummary), limit);
    if (collapsed.events.length >= limit || rows.length < window || window >= cap) return { ...collapsed, rows, window };
    window = Math.min(window * 4, cap);
  }
}
