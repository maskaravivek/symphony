import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface EpisodeEventInput {
  repo_id: string;
  episode_id: string;
  event: string;
  payload?: Record<string, unknown>;
  created_at?: string;
}

export interface EpisodeEvent extends Required<EpisodeEventInput> {
  sequence: number;
}

export interface EpisodeEventFilter {
  repo_id?: string;
  episode_id?: string;
  event?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface RetryRecord {
  repo_id: string;
  issue_id: string;
  issue_number: number;
  issue_identifier: string;
  attempt: number;
  reason: string;
  next_run_at: string;
  workspace_path: string | null;
  mode: string;
}

export interface ReviewClaim {
  repo_id: string;
  review_key: string;
  status: string;
  updated_at: string;
}

export interface MergeAssessmentRecord {
  repo_id: string;
  pr_number: number;
  input_fingerprint: string;
  decision_fingerprint: string;
  next_check_at: string;
}

interface EpisodeEventRow {
  sequence: number;
  repo_id: string;
  episode_id: string;
  event: string;
  payload_json: string;
  created_at: string;
}

export class EpisodeStore {
  private readonly database: DatabaseSyncType;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS episode_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS episode_events_repo_episode
        ON episode_events (repo_id, episode_id, sequence);
      CREATE INDEX IF NOT EXISTS episode_events_event
        ON episode_events (repo_id, event, sequence);
      CREATE TABLE IF NOT EXISTS retry_queue (
        repo_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        issue_identifier TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        reason TEXT NOT NULL,
        next_run_at TEXT NOT NULL,
        workspace_path TEXT,
        mode TEXT NOT NULL,
        PRIMARY KEY (repo_id, issue_id)
      );
      CREATE TABLE IF NOT EXISTS review_claims (
        repo_id TEXT NOT NULL,
        review_key TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, review_key)
      );
      CREATE TABLE IF NOT EXISTS merge_assessments (
        repo_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        input_fingerprint TEXT NOT NULL,
        decision_fingerprint TEXT NOT NULL,
        next_check_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, pr_number)
      );
    `);
  }

  append(input: EpisodeEventInput): EpisodeEvent {
    const createdAt = input.created_at ?? new Date().toISOString();
    const payload = input.payload ?? {};
    const result = this.database
      .prepare(
        `INSERT INTO episode_events (repo_id, episode_id, event, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.repo_id, input.episode_id, input.event, JSON.stringify(payload), createdAt);

    return {
      sequence: Number(result.lastInsertRowid),
      repo_id: input.repo_id,
      episode_id: input.episode_id,
      event: input.event,
      payload,
      created_at: createdAt,
    };
  }

  list(filter: EpisodeEventFilter = {}): EpisodeEvent[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filter.repo_id) {
      clauses.push('repo_id = ?');
      values.push(filter.repo_id);
    }
    if (filter.episode_id) {
      clauses.push('episode_id = ?');
      values.push(filter.episode_id);
    }
    if (filter.event) {
      clauses.push('event = ?');
      values.push(filter.event);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 500, 5_000));
    values.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database
      .prepare(
        `SELECT sequence, repo_id, episode_id, event, payload_json, created_at
         FROM episode_events ${where}
         ORDER BY sequence ${filter.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
      )
      .all(...values) as unknown as EpisodeEventRow[];

    return rows.map((row) => ({
      sequence: row.sequence,
      repo_id: row.repo_id,
      episode_id: row.episode_id,
      event: row.event,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      created_at: row.created_at,
    }));
  }

  latest(filter: Omit<EpisodeEventFilter, 'limit'> = {}): EpisodeEvent | null {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.repo_id) {
      clauses.push('repo_id = ?');
      values.push(filter.repo_id);
    }
    if (filter.episode_id) {
      clauses.push('episode_id = ?');
      values.push(filter.episode_id);
    }
    if (filter.event) {
      clauses.push('event = ?');
      values.push(filter.event);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const row = this.database
      .prepare(
        `SELECT sequence, repo_id, episode_id, event, payload_json, created_at
         FROM episode_events ${where}
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(...values) as unknown as EpisodeEventRow | undefined;
    if (!row) return null;
    return {
      sequence: row.sequence,
      repo_id: row.repo_id,
      episode_id: row.episode_id,
      event: row.event,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      created_at: row.created_at,
    };
  }

  upsertRetry(record: RetryRecord): void {
    this.database.prepare(`
      INSERT INTO retry_queue
        (repo_id, issue_id, issue_number, issue_identifier, attempt, reason, next_run_at, workspace_path, mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, issue_id) DO UPDATE SET
        issue_number=excluded.issue_number,
        issue_identifier=excluded.issue_identifier,
        attempt=excluded.attempt,
        reason=excluded.reason,
        next_run_at=excluded.next_run_at,
        workspace_path=excluded.workspace_path,
        mode=excluded.mode
    `).run(
      record.repo_id,
      record.issue_id,
      record.issue_number,
      record.issue_identifier,
      record.attempt,
      record.reason,
      record.next_run_at,
      record.workspace_path,
      record.mode,
    );
  }

  listRetries(repoId: string): RetryRecord[] {
    const rows = this.database.prepare(`
      SELECT repo_id, issue_id, issue_number, issue_identifier, attempt, reason, next_run_at, workspace_path, mode
      FROM retry_queue WHERE repo_id = ? ORDER BY next_run_at, issue_number
    `).all(repoId) as unknown as RetryRecord[];
    return rows.map((row) => ({ ...row }));
  }

  deleteRetry(repoId: string, issueId: string): void {
    this.database.prepare('DELETE FROM retry_queue WHERE repo_id = ? AND issue_id = ?').run(repoId, issueId);
  }

  claimReview(repoId: string, reviewKey: string, status: string): boolean {
    const result = this.database.prepare(`
      INSERT INTO review_claims (repo_id, review_key, status, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(repo_id, review_key) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at
      WHERE review_claims.status IN ('error', 'unavailable')
    `).run(repoId, reviewKey, status, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  completeReviewClaim(repoId: string, reviewKey: string, status: string): void {
    this.database.prepare(`
      INSERT INTO review_claims (repo_id, review_key, status, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(repo_id, review_key) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at
    `).run(repoId, reviewKey, status, new Date().toISOString());
  }

  getReviewClaim(repoId: string, reviewKey: string): ReviewClaim | null {
    return (this.database.prepare(`
      SELECT repo_id, review_key, status, updated_at FROM review_claims WHERE repo_id = ? AND review_key = ?
    `).get(repoId, reviewKey) as unknown as ReviewClaim | undefined) ?? null;
  }

  upsertMergeAssessment(record: MergeAssessmentRecord): void {
    this.database.prepare(`
      INSERT INTO merge_assessments (repo_id, pr_number, input_fingerprint, decision_fingerprint, next_check_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, pr_number) DO UPDATE SET
        input_fingerprint=excluded.input_fingerprint,
        decision_fingerprint=excluded.decision_fingerprint,
        next_check_at=excluded.next_check_at
    `).run(record.repo_id, record.pr_number, record.input_fingerprint, record.decision_fingerprint, record.next_check_at);
  }

  getMergeAssessment(repoId: string, prNumber: number): MergeAssessmentRecord | null {
    return (this.database.prepare(`
      SELECT repo_id, pr_number, input_fingerprint, decision_fingerprint, next_check_at
      FROM merge_assessments WHERE repo_id = ? AND pr_number = ?
    `).get(repoId, prNumber) as unknown as MergeAssessmentRecord | undefined) ?? null;
  }

  clearMergeAssessment(repoId: string, prNumber: number): void {
    this.database.prepare('DELETE FROM merge_assessments WHERE repo_id = ? AND pr_number = ?').run(repoId, prNumber);
  }

  close(): void {
    this.database.close();
  }
}
