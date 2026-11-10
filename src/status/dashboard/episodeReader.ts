import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import type { EpisodeEvent, MergeAssessmentRecord, RetryRecord, ReviewClaim } from '../../episodes/episodeStore.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

interface EpisodeEventRow {
  sequence: number;
  repo_id: string;
  episode_id: string;
  event: string;
  payload_json: string;
  created_at: string;
}

export function episodeDatabasePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.symphony', 'episodes.sqlite');
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toEvent(row: EpisodeEventRow): EpisodeEvent {
  return {
    sequence: Number(row.sequence),
    repo_id: row.repo_id,
    episode_id: row.episode_id,
    event: row.event,
    payload: parsePayload(row.payload_json),
    created_at: row.created_at,
  };
}

export interface EventQuery {
  events?: string[];
  before?: number;
  since?: string;
  /** Timestamp bound for the cross-repository event feed. */
  createdBefore?: string;
  includeCreatedBefore?: boolean;
  sequenceAtCreatedBefore?: number;
  byTime?: boolean;
  /** Issue/PR numbers the events must reference (episode id or payload). */
  numbers?: number[];
  loopIds?: string[];
  limit: number;
  order?: 'asc' | 'desc';
}

/**
 * Read-only, bounded access to `<workspace.root>/.symphony/episodes.sqlite`. Every query has a
 * LIMIT; nothing loads whole tables. A missing database reads as empty.
 */
export class EpisodeReader {
  private constructor(private readonly db: DatabaseSyncType | null) {}

  static open(workspaceRoot: string | null): EpisodeReader {
    if (!workspaceRoot) return new EpisodeReader(null);
    const file = episodeDatabasePath(workspaceRoot);
    if (!fs.existsSync(file)) return new EpisodeReader(null);
    try {
      return new EpisodeReader(new DatabaseSync(file, { readOnly: true }));
    } catch {
      return new EpisodeReader(null);
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // Already closed.
    }
  }

  private all<T>(sql: string, values: Array<string | number>): T[] {
    if (!this.db) return [];
    try {
      return this.db.prepare(sql).all(...values) as unknown as T[];
    } catch {
      // Missing tables on very old databases, or a locked/corrupt file: show nothing rather than fail.
      return [];
    }
  }

  listEvents(query: EventQuery): EpisodeEvent[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.events && query.events.length > 0) {
      clauses.push(`event IN (${query.events.map(() => '?').join(', ')})`);
      values.push(...query.events);
    }
    if (query.before !== undefined) {
      clauses.push('sequence < ?');
      values.push(query.before);
    }
    if (query.since) {
      clauses.push('created_at >= ?');
      values.push(query.since);
    }
    if (query.createdBefore) {
      if (query.sequenceAtCreatedBefore !== undefined) {
        clauses.push('(created_at < ? OR (created_at = ? AND sequence < ?))');
        values.push(query.createdBefore, query.createdBefore, query.sequenceAtCreatedBefore);
      } else {
        clauses.push(query.includeCreatedBefore ? 'created_at <= ?' : 'created_at < ?');
        values.push(query.createdBefore);
      }
    }
    const refs: string[] = [];
    for (const number of query.numbers ?? []) {
      refs.push("episode_id LIKE ? ESCAPE '\\'", 'episode_id = ?');
      values.push(`%#${number}:%`, `pr-${number}`);
      refs.push("json_extract(payload_json, '$.issue_number') = ?", "json_extract(payload_json, '$.pr_number') = ?");
      values.push(number, number);
    }
    for (const loopId of query.loopIds ?? []) {
      refs.push('episode_id = ?', "json_extract(payload_json, '$.loop_id') = ?");
      values.push(`loop-${loopId}`, loopId);
    }
    if (refs.length > 0) clauses.push(`(${refs.join(' OR ')})`);
    const limit = Math.max(1, Math.min(Math.floor(query.limit), 5_000));
    values.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.all<EpisodeEventRow>(
      `SELECT sequence, repo_id, episode_id, event, payload_json, created_at FROM episode_events ${where}
       ORDER BY ${query.byTime ? 'created_at DESC, ' : ''}sequence DESC LIMIT ?`,
      values,
    );
    const events = rows.map(toEvent);
    return query.order === 'asc' ? events.reverse() : events;
  }

  latestEvent(event: string, episodeId: string): EpisodeEvent | null {
    const rows = this.all<EpisodeEventRow>(
      `SELECT sequence, repo_id, episode_id, event, payload_json, created_at FROM episode_events
       WHERE event = ? AND episode_id = ? ORDER BY sequence DESC LIMIT 1`,
      [event, episodeId],
    );
    return rows[0] ? toEvent(rows[0]) : null;
  }

  /**
   * Latest `loop.triggered` for a loop and the latest `loop.completed`/`loop.failed` after it
   * (or simply the latest outcome when no trigger was recorded).
   */
  loopActivity(loopId: string): { triggered: EpisodeEvent | null; outcome: EpisodeEvent | null } {
    const events = this.listEvents({ events: ['loop.triggered', 'loop.completed', 'loop.failed'], loopIds: [loopId], limit: 20 });
    const triggerIndex = events.findIndex((event) => event.event === 'loop.triggered');
    const triggered = triggerIndex === -1 ? null : events[triggerIndex]!;
    const candidates = triggerIndex === -1 ? events : events.slice(0, triggerIndex);
    return { triggered, outcome: candidates.find((event) => event.event !== 'loop.triggered') ?? null };
  }

  /** Most recent `merge.blocked` / `merge.merged` per PR among the last `limit` merge events. */
  latestMergeEvents(limit = 500): Map<number, EpisodeEvent> {
    const byPr = new Map<number, EpisodeEvent>();
    for (const event of this.listEvents({ events: ['merge.blocked', 'merge.merged'], limit })) {
      const pr = numberField(event.payload.pr_number) ?? prNumberFromEpisodeId(event.episode_id);
      if (pr !== null && !byPr.has(pr)) byPr.set(pr, event);
    }
    return byPr;
  }

  /** Most recent `pr.feedback_queued` per PR. */
  latestFeedbackEvents(limit = 300): Map<number, EpisodeEvent> {
    const byPr = new Map<number, EpisodeEvent>();
    for (const event of this.listEvents({ events: ['pr.feedback_queued', 'pr.feedback_exhausted'], limit })) {
      const pr = numberField(event.payload.pr_number) ?? prNumberFromEpisodeId(event.episode_id);
      if (pr !== null && !byPr.has(pr)) byPr.set(pr, event);
    }
    return byPr;
  }

  retries(limit = 500): RetryRecord[] {
    return this.all<RetryRecord>(
      `SELECT repo_id, issue_id, issue_number, issue_identifier, attempt, reason, next_run_at, workspace_path, mode
       FROM retry_queue ORDER BY next_run_at, issue_number LIMIT ?`,
      [limit],
    ).map((row) => ({ ...row, issue_number: Number(row.issue_number), attempt: Number(row.attempt) }));
  }

  reviewClaims(limit = 1_000): ReviewClaim[] {
    return this.all<ReviewClaim>(
      'SELECT repo_id, review_key, status, updated_at, attempts FROM review_claims ORDER BY updated_at DESC LIMIT ?',
      [limit],
    ).map((row) => ({ ...row, attempts: Number(row.attempts) }));
  }

  mergeAssessments(limit = 500): MergeAssessmentRecord[] {
    return this.all<MergeAssessmentRecord>(
      'SELECT repo_id, pr_number, input_fingerprint, decision_fingerprint, next_check_at FROM merge_assessments LIMIT ?',
      [limit],
    ).map((row) => ({ ...row, pr_number: Number(row.pr_number) }));
  }
}

export function numberField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function prNumberFromEpisodeId(episodeId: string): number | null {
  const match = /^pr-(\d+)$/.exec(episodeId);
  return match ? Number(match[1]) : null;
}

export function issueNumberFromEpisodeId(episodeId: string): number | null {
  const match = /#(\d+):/.exec(episodeId);
  return match ? Number(match[1]) : null;
}

export function loopIdFromEpisodeId(episodeId: string): string | null {
  const match = /^loop-(.+)$/.exec(episodeId);
  return match ? match[1]! : null;
}
